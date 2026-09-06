import { useState, useEffect } from 'react'
import { X, ArrowUpDown } from 'lucide-react'
import { BrowserProvider, getAddress } from 'ethers'
import { initSDK, createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/web'
import { ADDRESSES } from './contracts'

const EASE = 'cubic-bezier(0.4,0,0.2,1)'
const ACCENT = '#E882B4'

type Direction = 'mToC' | 'cToM'
// cToM steps: encrypting → unwrapping (tx1) → decrypting (off-chain publicDecrypt) → finalizing (tx2) → done
type Step = 'input' | 'approving' | 'swapping' | 'encrypting' | 'unwrapping' | 'decrypting' | 'finalizing' | 'done' | 'error'

async function hasCusdBalance(wallet: string): Promise<boolean> {
  try {
    const data = '0x344ff101' + wallet.slice(2).toLowerCase().padStart(64, '0')
    const res = await fetch(import.meta.env.VITE_SEPOLIA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ADDRESSES.cusd, data }, 'latest'] }),
    })
    const json = await res.json()
    const handle = json.result as string
    if (!handle || handle === '0x') return false
    // Zero handle means no balance — confidentialBalanceOf returns 0x000...000 for empty accounts
    try { return BigInt(handle) !== 0n } catch { return false }
  } catch {
    return false
  }
}

async function sendTx(eth: any, params: Record<string, string>): Promise<string | null> {
  const nonceBefore = parseInt(
    await eth.request({ method: 'eth_getTransactionCount', params: [params.from, 'latest'] }), 16
  )
  try {
    return await eth.request({ method: 'eth_sendTransaction', params: [params] })
  } catch (e: any) {
    if (e?.code === 4100) {
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const nonceNow = parseInt(
          await eth.request({ method: 'eth_getTransactionCount', params: [params.from, 'latest'] }), 16
        )
        if (nonceNow > nonceBefore) {
          for (let back = 0; back < 5; back++) {
            const blockTag = '0x' + (parseInt(
              await eth.request({ method: 'eth_blockNumber' }), 16
            ) - back).toString(16)
            const block = await eth.request({ method: 'eth_getBlockByNumber', params: [blockTag, true] })
            const tx = block?.transactions?.find(
              (t: any) => t.from?.toLowerCase() === params.from.toLowerCase() && parseInt(t.nonce, 16) === nonceBefore
            )
            if (tx?.hash) return tx.hash
          }
          return null
        }
      }
      throw new Error('timed out waiting for nonce increment after 4100')
    }
    throw e
  }
}

async function waitForReceipt(eth: any, txHash: string): Promise<any> {
  for (;;) {
    const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [txHash] })
    if (receipt) {
      if (receipt.status === '0x0') throw new Error('transaction reverted')
      return receipt
    }
    await new Promise(r => setTimeout(r, 2000))
  }
}

// Parse UnwrapRequested from receipt logs emitted by the cUSD contract.
// The event has two indexed params: (address indexed receiver, bytes32 indexed unwrapRequestId, ...)
// so topics = [topic0, receiver, requestId].
// We match any log from ADDRESSES.cusd with 3 topics where topic0 starts with 0x5a269973
// (keccak256 of the uint64 variant) or 0x4b1bfb26 (bytes32 variant for euint64 UDVT) as a
// belt-and-suspenders check — the address filter is the reliable anchor.
function parseUnwrapRequestId(receipt: any, cusdAddress: string): string | null {
  for (const log of receipt.logs ?? []) {
    if (
      log.address?.toLowerCase() === cusdAddress.toLowerCase() &&
      log.topics?.length >= 3
    ) {
      const t0: string = log.topics[0].toLowerCase()
      if (
        t0.startsWith('0x5a269973') || // uint64 variant
        t0.startsWith('0x4b1bfb26')    // bytes32/euint64 UDVT variant
      ) {
        return log.topics[2] as string
      }
    }
  }
  return null
}

export function SimpleSwapModal({
  wallet,
  onClose,
}: {
  wallet: string | null
  onClose: () => void
}) {
  const [direction, setDirection] = useState<Direction>('mToC')
  const [amount, setAmount]       = useState('')
  const [step, setStep]           = useState<Step>('input')
  const [errorMsg, setErrorMsg]   = useState<string | null>(null)
  const [hasCusd, setHasCusd]     = useState<boolean | null>(null)

  useEffect(() => {
    if (!wallet) return
    hasCusdBalance(wallet).then(setHasCusd)
  }, [wallet])

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const fromToken = direction === 'mToC' ? 'mUSDC' : 'cUSD'
  const toToken   = direction === 'mToC' ? 'cUSD'  : 'mUSDC'
  const outAmount = amount && Number(amount) > 0 ? Number(amount).toFixed(2) : '0.00'

  // ── mUSDC → cUSD (wrap) ──────────────────────────────────────────────────
  const handleWrap = async () => {
    if (!amount || Number(amount) <= 0 || !wallet) return
    setStep('approving')
    setErrorMsg(null)
    const eth = (window as any).ethereum
    try {
      const provider = new BrowserProvider(eth)
      const signer = await provider.getSigner()
      const checksumWallet = getAddress(await signer.getAddress())
      const rawAmount = BigInt(Math.round(Number(amount) * 1e6))

      // Always send approve — never skip, to avoid stale-allowance races on Sepolia.
      // approve(address,uint256) = 0x095ea7b3
      const approveData = '0x095ea7b3' +
        ADDRESSES.cusd.slice(2).toLowerCase().padStart(64, '0') +
        rawAmount.toString(16).padStart(64, '0')
      const approveTx = await sendTx(eth, { from: checksumWallet, to: ADDRESSES.usdc, data: approveData, gas: '0x186a0' })
      if (approveTx) await waitForReceipt(eth, approveTx)

      // Verify allowance landed — retry up to 5× (Sepolia nodes can lag a few blocks)
      const allowanceData = '0xdd62ed3e' +
        checksumWallet.slice(2).toLowerCase().padStart(64, '0') +
        ADDRESSES.cusd.slice(2).toLowerCase().padStart(64, '0')
      let verifiedAllowance = 0n
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const verifyRes = await fetch(import.meta.env.VITE_SEPOLIA_RPC_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: ADDRESSES.usdc, data: allowanceData }, 'latest'] }),
        })
        verifiedAllowance = BigInt((await verifyRes.json()).result ?? '0x0')
        if (verifiedAllowance >= rawAmount) break
      }
      if (verifiedAllowance < rawAmount) throw new Error('Approval did not land — please try again')

      // wrap(address,uint256) selector = 0xbf376c7a
      setStep('swapping')
      const wrapData = '0xbf376c7a' +
        checksumWallet.slice(2).toLowerCase().padStart(64, '0') +
        rawAmount.toString(16).padStart(64, '0')
      const wrapTx = await sendTx(eth, { from: checksumWallet, to: ADDRESSES.cusd, data: wrapData, gas: '0x493E0' })
      if (wrapTx) await waitForReceipt(eth, wrapTx)
      else await new Promise(r => setTimeout(r, 4000))

      setStep('done')
    } catch (e: any) {
      if (e?.code === 4001) { setErrorMsg('Transaction rejected in MetaMask.'); setStep('error'); return }
      const msg = e?.message ?? e?.reason ?? e?.info?.error?.message ?? JSON.stringify(e)
      setErrorMsg(msg)
      setStep('error')
    }
  }

  // ── cUSD → mUSDC (unwrap — two-phase: unwrap(address,address,bytes32,bytes) → publicDecrypt → finalizeUnwrap) ─
  const handleUnwrap = async () => {
    if (!amount || Number(amount) <= 0 || !wallet) return
    setErrorMsg(null)
    const eth = (window as any).ethereum

    try {
      const provider = new BrowserProvider(eth)
      const signer = await provider.getSigner()
      const checksumWallet = getAddress(await signer.getAddress())
      const rawAmount = BigInt(Math.round(Number(amount) * 1e6))

      // Step 1: init SDK and encrypt the amount bound to the cUSD contract
      // unwrap calls FHE.fromExternal internally, so contractAddress must be CUSD_ADDRESS
      setStep('encrypting')
      await initSDK()
      const instance = await createInstance({
        ...SepoliaConfig,
        network: import.meta.env.VITE_SEPOLIA_RPC_URL,
      })
      const buffer = instance.createEncryptedInput(ADDRESSES.cusd, checksumWallet)
      buffer.add64(rawAmount)
      const ciphertext = await buffer.encrypt()
      const handleBytes: Uint8Array = ciphertext.handles[0]
      const proofBytes: Uint8Array = ciphertext.inputProof
      const handleHex = Array.from(handleBytes).map(b => b.toString(16).padStart(2, '0')).join('')
      const proofHex = Array.from(proofBytes).map(b => b.toString(16).padStart(2, '0')).join('')
      const proofPadded = proofHex.padEnd(Math.ceil(proofHex.length / 64) * 64, '0')

      // Step 2: call unwrap(address from, address to, externalEuint64 encryptedAmount, bytes inputProof)
      // externalEuint64 ABI-encodes as bytes32 → selector: keccak256("unwrap(address,address,bytes32,bytes)")[0:4] = 0x5bf4ef06
      // ABI layout: selector | from (32) | to (32) | handle (32) | offset (32) | length (32) | proof_padded
      // offset = 4 fixed params × 32 = 128 = 0x80
      setStep('unwrapping')
      const unwrapData = '0x' +
        '5bf4ef06' +
        checksumWallet.slice(2).toLowerCase().padStart(64, '0') +   // from
        checksumWallet.slice(2).toLowerCase().padStart(64, '0') +   // to
        handleHex.padStart(64, '0') +                               // encryptedAmount (bytes32)
        '0000000000000000000000000000000000000000000000000000000000000080' + // offset: 4×32 = 128
        (proofHex.length / 2).toString(16).padStart(64, '0') +     // length of proof in bytes
        proofPadded                                                   // proof data

      const unwrapTx = await sendTx(eth, { from: checksumWallet, to: ADDRESSES.cusd, data: unwrapData, gas: '0x7A120' })
      let receipt: any = null
      if (unwrapTx) {
        receipt = await waitForReceipt(eth, unwrapTx)
      } else {
        // 4100 path — tx landed but hash unavailable; poll recent blocks for UnwrapRequested
        await new Promise(r => setTimeout(r, 4000))
      }

      // Step 3: get the unwrapRequestId from the UnwrapRequested event
      let requestId: string | null = receipt ? parseUnwrapRequestId(receipt, ADDRESSES.cusd) : null

      if (!requestId) {
        // Fallback: scan last 5 blocks for the event
        const latestBlock = parseInt(await eth.request({ method: 'eth_blockNumber' }), 16)
        for (let back = 0; back < 5 && !requestId; back++) {
          const blockTag = '0x' + (latestBlock - back).toString(16)
          const block = await eth.request({ method: 'eth_getBlockByNumber', params: [blockTag, false] })
          for (const txHash of block?.transactions ?? []) {
            const r = await eth.request({ method: 'eth_getTransactionReceipt', params: [txHash] })
            if (r) {
              const id = parseUnwrapRequestId(r, ADDRESSES.cusd)
              if (id) { requestId = id; break }
            }
          }
        }
      }

      if (!requestId) throw new Error('Could not find UnwrapRequested event — check Etherscan for the requestId and finalize manually')

      // Step 4: off-chain publicDecrypt to get the cleartext + proof
      setStep('decrypting')
      const { clearValues, decryptionProof } = await instance.publicDecrypt([requestId as `0x${string}`])
      const cleartextAmount = BigInt(clearValues[requestId as `0x${string}`] as string | bigint)

      // Step 5: finalizeUnwrap(bytes32 unwrapRequestId, uint64 unwrapAmountCleartext, bytes decryptionProof)
      // selector: keccak256("finalizeUnwrap(bytes32,uint64,bytes)")[0:4] = 0x5bb67a05
      setStep('finalizing')

      const toHexStr = (v: Uint8Array | string): string => {
        if (typeof v === 'string') return v.startsWith('0x') ? v.slice(2) : v
        return Array.from(v as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('')
      }
      const proofDecHex = toHexStr(decryptionProof as any)

      const proofDecPadded = proofDecHex.padEnd(Math.ceil(proofDecHex.length / 64) * 64, '0')
      const finalizeData = '0x' +
        // finalizeUnwrap(bytes32,uint64,bytes) selector = 0x5bb67a05
        '5bb67a05' +
        requestId.slice(2).padStart(64, '0') +                              // unwrapRequestId
        cleartextAmount.toString(16).padStart(64, '0') +                    // unwrapAmountCleartext
        '0000000000000000000000000000000000000000000000000000000000000060' + // offset to bytes
        (proofDecHex.length / 2).toString(16).padStart(64, '0') +          // length
        proofDecPadded                                                        // decryptionProof bytes

      const finalizeTx = await sendTx(eth, { from: checksumWallet, to: ADDRESSES.cusd, data: finalizeData, gas: '0x7A120' })
      if (finalizeTx) await waitForReceipt(eth, finalizeTx)

      setStep('done')
    } catch (e: any) {
      if (e?.code === 4001) { setErrorMsg('Transaction rejected in MetaMask.'); setStep('error'); return }
      const msg = e?.message ?? e?.reason ?? e?.info?.error?.message ?? JSON.stringify(e)
      setErrorMsg(msg)
      setStep('error')
    }
  }

  const handleSwap = direction === 'mToC' ? handleWrap : handleUnwrap

  const toggleDirection = () => {
    setDirection(d => d === 'mToC' ? 'cToM' : 'mToC')
    setAmount('')
    setStep('input')
    setErrorMsg(null)
  }

  const isBusy = ['approving','swapping','encrypting','unwrapping','decrypting','finalizing'].includes(step)

  const busyLabel: Record<string, string> = {
    approving:  '⏳ Approving mUSDC...',
    swapping:   '⏳ Wrapping to cUSD...',
    encrypting: '⏳ Initialising FHE SDK...',
    unwrapping: '⏳ Submitting unwrap tx...',
    decrypting: '🔓 Running FHE publicDecrypt...',
    finalizing: '⏳ Finalizing unwrap...',
  }

  return (
    <div
      onClick={onBackdrop}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 420, borderRadius: 20,
          background: '#13131A', border: `1.5px solid ${ACCENT}44`,
          padding: '1.75rem', position: 'relative',
          boxShadow: '0 24px 60px -10px rgba(0,0,0,0.7)',
        }}
      >
        {/* Close */}
        <button onClick={onClose} style={{
          position: 'absolute', top: 16, right: 16,
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 50, width: 32, height: 32, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.5)',
        }}>
          <X size={15} />
        </button>

        {/* Header */}
        <div style={{ marginBottom: '1.75rem' }}>
          <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.2rem', color: 'white', letterSpacing: '0.06em', marginBottom: 4 }}>
            SWAP TOKENS
          </div>
          <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            1 {fromToken} = 1 {toToken} · no fees · Zama FHE
          </div>
          {wallet && hasCusd !== null && (
            <div style={{
              marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6,
              background: hasCusd ? 'rgba(107,191,122,0.1)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${hasCusd ? 'rgba(107,191,122,0.3)' : 'rgba(255,255,255,0.1)'}`,
              borderRadius: 20, padding: '3px 10px',
            }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: hasCusd ? '#6BBF7A' : 'rgba(255,255,255,0.25)', flexShrink: 0 }} />
              <span style={{ fontSize: '0.6rem', fontWeight: 700, color: hasCusd ? '#6BBF7A' : 'rgba(255,255,255,0.3)', letterSpacing: '0.08em' }}>
                {hasCusd ? 'cUSD BALANCE: ENCRYPTED ✓' : 'NO cUSD BALANCE'}
              </span>
            </div>
          )}
        </div>

        {step === 'done' ? (
          <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🎉</div>
            <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.2rem', color: '#6BBF7A', letterSpacing: '0.05em', marginBottom: 6 }}>SWAP SUCCESSFUL</div>
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)', marginBottom: '1.5rem' }}>
              Your {toToken} is ready.
            </div>
            <button onClick={onClose} style={{
              width: '100%', padding: '0.85rem',
              background: '#6BBF7A', border: 'none', borderRadius: 50,
              color: '#0A0A0F', fontSize: '0.78rem', fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
            }}>DONE</button>
          </div>
        ) : step === 'error' ? (
          <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>⚠️</div>
            <div style={{
              fontSize: '0.7rem', color: '#F4845F',
              background: 'rgba(244,132,95,0.08)', border: '1px solid rgba(244,132,95,0.25)',
              borderRadius: 8, padding: '0.75rem', marginBottom: '1.25rem',
              wordBreak: 'break-word', textAlign: 'left', lineHeight: 1.5,
            }}>{errorMsg}</div>
            <button onClick={() => { setStep('input'); setErrorMsg(null) }} style={{
              width: '100%', padding: '0.85rem',
              background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 50, color: 'white', fontSize: '0.78rem', fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
            }}>TRY AGAIN</button>
          </div>
        ) : (
          <>
            {/* Direction toggle */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr auto 1fr',
              alignItems: 'center', gap: 10, marginBottom: '1.25rem',
            }}>
              <div style={{
                background: 'rgba(255,255,255,0.04)', border: '1.5px solid rgba(255,255,255,0.1)',
                borderRadius: 14, padding: '0.85rem 1rem',
              }}>
                <div style={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>FROM</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: ACCENT }}>{fromToken}</div>
              </div>

              <button onClick={toggleDirection} style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: `${ACCENT}22`, border: `1.5px solid ${ACCENT}55`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', transition: `transform 300ms ${EASE}`,
              }}
                onMouseEnter={e => (e.currentTarget.style.transform = 'rotate(180deg)')}
                onMouseLeave={e => (e.currentTarget.style.transform = 'rotate(0deg)')}
              >
                <ArrowUpDown size={15} color={ACCENT} />
              </button>

              <div style={{
                background: `${ACCENT}0D`, border: `1.5px solid ${ACCENT}33`,
                borderRadius: 14, padding: '0.85rem 1rem',
              }}>
                <div style={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>TO</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: ACCENT }}>{toToken}</div>
              </div>
            </div>

            {/* cToM info banner */}
            {direction === 'cToM' && (
              <div style={{
                background: 'rgba(232,130,180,0.06)', border: `1px solid ${ACCENT}33`,
                borderRadius: 10, padding: '0.65rem 0.9rem', marginBottom: '1rem',
                fontSize: '0.62rem', color: 'rgba(255,255,255,0.4)', lineHeight: 1.6,
              }}>
                🔐 <strong style={{ color: 'rgba(255,255,255,0.6)' }}>Two-phase FHE unwrap:</strong> amount is encrypted client-side,
                sent on-chain, then a Zama publicDecrypt round-trip finalizes the transfer.
                Two MetaMask confirmations required.
              </div>
            )}

            {/* Amount input */}
            <div style={{ marginBottom: '0.85rem' }}>
              <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                Amount ({fromToken})
              </div>
              <div style={{
                display: 'flex', alignItems: 'center',
                background: 'rgba(255,255,255,0.05)', border: '1.5px solid rgba(255,255,255,0.12)',
                borderRadius: 12, overflow: 'hidden',
              }}>
                <input
                  type="number" placeholder="0.00" value={amount}
                  onChange={e => setAmount(e.target.value)}
                  style={{
                    flex: 1, background: 'transparent', border: 'none', outline: 'none',
                    color: 'white', fontSize: '1.2rem', fontWeight: 600, padding: '0.9rem 1rem',
                  }}
                />
                <span style={{ padding: '0 1rem', fontSize: '0.75rem', fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.08em' }}>
                  {fromToken}
                </span>
              </div>
            </div>

            {/* You receive */}
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                You receive ({toToken})
              </div>
              <div style={{
                display: 'flex', alignItems: 'center',
                background: 'rgba(255,255,255,0.03)', border: `1.5px solid ${ACCENT}33`,
                borderRadius: 12, overflow: 'hidden',
              }}>
                <div style={{
                  flex: 1, padding: '0.9rem 1rem',
                  fontSize: '1.2rem', fontWeight: 600,
                  color: outAmount === '0.00' ? 'rgba(255,255,255,0.2)' : ACCENT,
                }}>
                  {outAmount}
                </div>
                <span style={{ padding: '0 1rem', fontSize: '0.75rem', fontWeight: 700, color: ACCENT, letterSpacing: '0.08em' }}>
                  {toToken}
                </span>
              </div>
            </div>

            {/* Wallet row */}
            {wallet && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'rgba(255,255,255,0.03)', borderRadius: 10,
                padding: '0.65rem 0.85rem', marginBottom: '1.25rem',
              }}>
                <span style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Connected</span>
                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#6BBF7A', fontFamily: 'monospace' }}>
                  {wallet.slice(0, 6)}...{wallet.slice(-4)}
                </span>
              </div>
            )}

            {/* Swap button / busy state */}
            {isBusy ? (
              <div style={{ textAlign: 'center', padding: '0.75rem 0' }}>
                <div style={{ fontSize: '0.78rem', color: ACCENT, fontWeight: 600, letterSpacing: '0.06em' }}>
                  {busyLabel[step]}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', marginTop: 4 }}>
                  {step === 'encrypting' || step === 'decrypting' ? 'Running FHE — no MetaMask needed yet' : 'Confirm in MetaMask if prompted'}
                </div>
              </div>
            ) : !wallet ? (
              <div style={{ textAlign: 'center', fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', padding: '0.5rem 0' }}>
                Connect your wallet to swap
              </div>
            ) : (
              <button
                onClick={handleSwap}
                disabled={!amount || Number(amount) <= 0}
                style={{
                  width: '100%', padding: '0.9rem',
                  background: !amount || Number(amount) <= 0
                    ? 'rgba(255,255,255,0.06)'
                    : `linear-gradient(135deg, ${ACCENT}, #B85A9A)`,
                  border: 'none', borderRadius: 50,
                  color: !amount || Number(amount) <= 0 ? 'rgba(255,255,255,0.3)' : 'white',
                  fontSize: '0.8rem', fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  cursor: !amount || Number(amount) <= 0 ? 'not-allowed' : 'pointer',
                  transition: `background 200ms ${EASE}`,
                }}
              >
                SWAP {fromToken} → {toToken}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
