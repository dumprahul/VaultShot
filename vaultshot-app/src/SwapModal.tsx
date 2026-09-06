import { useState, useEffect } from 'react'
import { X, ArrowDown } from 'lucide-react'
import { BrowserProvider, Contract, formatUnits, Interface } from 'ethers'
import { ADDRESSES, USDC_ABI } from './contracts'

const EASE = 'cubic-bezier(0.4,0,0.2,1)'
const ACCENT = '#E882B4'

type Step = 'input' | 'approving' | 'swapping' | 'done' | 'error'

async function waitForReceipt(eth: any, txHash: string): Promise<void> {
  for (;;) {
    const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [txHash] })
    if (receipt) {
      if (receipt.status === '0x0') throw new Error('transaction reverted')
      return
    }
    await new Promise(r => setTimeout(r, 2000))
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
      // MetaMask threw 4100 but may have submitted the tx anyway — poll until confirmed nonce increments
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const nonceNow = parseInt(
          await eth.request({ method: 'eth_getTransactionCount', params: [params.from, 'latest'] }), 16
        )
        if (nonceNow > nonceBefore) {
          // Tx landed — scan recent blocks for the hash
          for (let back = 0; back < 8; back++) {
            const blockTag = '0x' + (parseInt(
              await eth.request({ method: 'eth_blockNumber' }), 16
            ) - back).toString(16)
            const block = await eth.request({ method: 'eth_getBlockByNumber', params: [blockTag, true] })
            const tx = block?.transactions?.find(
              (t: any) => t.from?.toLowerCase() === params.from.toLowerCase() && parseInt(t.nonce, 16) === nonceBefore
            )
            if (tx?.hash) return tx.hash
          }
          // Hash not found but nonce incremented — tx is on-chain, return null so caller
          // skips waitForReceipt and re-verifies state instead of throwing a false error.
          return null
        }
      }
      throw new Error('timed out waiting for nonce increment after 4100')
    }
    throw e
  }
}

export function SwapModal({
  wallet,
  onClose,
}: {
  wallet: string | null
  onClose: () => void
}) {
  const [amount, setAmount]           = useState('')
  const [step, setStep]               = useState<Step>('input')
  const [bubbleVisible, setBubbleVisible] = useState(false)
  const [errorMsg, setErrorMsg]       = useState<string | null>(null)
  const [faucetState, setFaucetState] = useState<'idle' | 'loading' | 'done' | 'cooldown'>('idle')
  const [tokenBalance, setTokenBalance] = useState<string | null>(null)

  const refreshBalance = async () => {
    if (!wallet) return
    const provider = new BrowserProvider((window as any).ethereum)
    const token = new Contract(ADDRESSES.usdc, USDC_ABI, provider)
    token.balanceOf(wallet).then((bal: bigint) => {
      setTokenBalance(formatUnits(bal, 6))
    }).catch(() => {})
  }

  useEffect(() => { refreshBalance() }, [wallet, faucetState])

  const handleFaucet = async () => {
    if (!wallet || faucetState === 'loading') return
    setFaucetState('loading')
    const eth = (window as any).ethereum
    try {
      const txHash = await sendTx(eth, {
        from: wallet,
        to: ADDRESSES.usdc,
        data: '0xde5f72fd',
        gas: '0x186a0',
      })
      await waitForReceipt(eth, txHash!)
      setFaucetState('done')
      await refreshBalance()
    } catch (e: any) {
      const msg = e?.message ?? e?.reason ?? e?.info?.error?.message ?? JSON.stringify(e)
      if (msg.toLowerCase().includes('cooldown')) {
        setFaucetState('cooldown')
      } else {
        setFaucetState('idle')
        console.error('faucet error', e)
      }
    }
  }

  useEffect(() => {
    const t = setTimeout(() => setBubbleVisible(true), 300)
    return () => clearTimeout(t)
  }, [])

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleSwap = async () => {
    if (!amount || Number(amount) <= 0 || !wallet) return
    setStep('approving')
    setErrorMsg(null)
    const eth = (window as any).ethereum
    try {
      const rawAmount = BigInt(Math.round(Number(amount) * 1e6))

      // Check current on-chain allowance first
      const allowanceData = '0xdd62ed3e' +
        wallet.slice(2).toLowerCase().padStart(64, '0') +
        ADDRESSES.cusd.slice(2).toLowerCase().padStart(64, '0')
      const allowanceRes = await fetch(import.meta.env.VITE_SEPOLIA_RPC_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ADDRESSES.usdc, data: allowanceData }, 'latest'] }),
      })
      const currentAllowance = BigInt((await allowanceRes.json()).result ?? '0x0')

      if (currentAllowance < rawAmount) {
        // Step 1: approve mUSDC → cUSD contract
        const approveIface = new Interface(['function approve(address spender, uint256 amount) returns (bool)'])
        const approveData = approveIface.encodeFunctionData('approve', [ADDRESSES.cusd, rawAmount])
        const approveTx = await sendTx(eth, { from: wallet, to: ADDRESSES.usdc, data: approveData, gas: '0x186a0' })
        if (approveTx) await waitForReceipt(eth, approveTx)

        // Re-verify allowance landed correctly before wrapping
        const verifyRes = await fetch(import.meta.env.VITE_SEPOLIA_RPC_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: ADDRESSES.usdc, data: allowanceData }, 'latest'] }),
        })
        const verifiedAllowance = BigInt((await verifyRes.json()).result ?? '0x0')
        if (verifiedAllowance < rawAmount) throw new Error('Approval did not land — please try again')
      }

      // Step 2: wrap(wallet, amount) — mUSDC in, cUSD out
      setStep('swapping')
      const wrapIface = new Interface(['function wrap(address to, uint256 amount)'])
      const wrapData = wrapIface.encodeFunctionData('wrap', [wallet, rawAmount])
      const wrapTx = await sendTx(eth, { from: wallet, to: ADDRESSES.cusd, data: wrapData, gas: '0x493E0' })
      if (wrapTx) await waitForReceipt(eth, wrapTx)
      else await new Promise(r => setTimeout(r, 4000)) // nonce incremented — tx is on-chain

      setStep('done')
    } catch (e: any) {
      setErrorMsg(e?.message ?? 'Swap failed')
      setStep('error')
    }
  }

  const outAmount = amount && Number(amount) > 0
    ? Number(amount).toFixed(2)
    : '0.00'

  return (
    <div
      onClick={onBackdrop}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
        overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {/* Blue figurine — fixed to viewport, right-aligned alongside modal */}
      <img
        src="/figurine-blue-boy.png"
        alt=""
        style={{
          position: 'fixed',
          bottom: 0,
          left: '50%',
          /* card is 390px wide, figurine sits just off the right edge */
          marginLeft: 390 / 2 - 260,
          height: '88vh',
          width: 'auto',
          filter: 'drop-shadow(-8px 0 40px rgba(110,181,255,0.4))',
          opacity: bubbleVisible ? 1 : 0,
          transform: bubbleVisible ? 'translateY(0)' : 'translateY(50px)',
          transition: `opacity 800ms ${EASE}, transform 800ms cubic-bezier(0.34,1.2,0.64,1)`,
          pointerEvents: 'none',
          zIndex: 101,
        }}
      />

      {/* Thought bubble above figurine — anchored same horizontal position */}
      <div style={{
        position: 'fixed',
        bottom: '84vh',
        left: '50%',
        marginLeft: 390 / 2 - 230,
        width: 280,
        opacity: bubbleVisible ? 1 : 0,
        transform: bubbleVisible ? 'scale(1)' : 'scale(0.4)',
        transformOrigin: 'bottom left',
        transition: `opacity 700ms ${EASE} 300ms, transform 700ms cubic-bezier(0.34,1.6,0.64,1) 300ms`,
        pointerEvents: 'none',
        zIndex: 102,
      }}>
        {/* Bubble body */}
        <div style={{
          background: 'linear-gradient(135deg, rgba(25,25,38,0.97) 0%, rgba(18,18,30,0.97) 100%)',
          border: '1.5px solid rgba(255,255,255,0.15)',
          borderRadius: 18, padding: '14px 16px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1)',
          position: 'relative',
        }}>
          {/* Corner accents */}
          <div style={{ position: 'absolute', top: -1, left: -1, width: 32, height: 32, borderTop: '2px solid #6EB5FF88', borderLeft: '2px solid #6EB5FF88', borderRadius: '18px 0 0 0' }} />
          <div style={{ position: 'absolute', bottom: -1, right: -1, width: 24, height: 24, borderBottom: '2px solid #6EB5FF44', borderRight: '2px solid #6EB5FF44', borderRadius: '0 0 18px 0' }} />

          <p style={{
            margin: '0 0 8px', fontSize: '0.72rem', fontWeight: 600, lineHeight: 1.5,
            textAlign: 'center', whiteSpace: 'pre-line', color:
              faucetState === 'done' ? '#6BBF7A' : faucetState === 'loading' ? '#6EB5FF' : 'white',
            transition: 'color 300ms ease',
          }}>
            {faucetState === 'loading'
              ? '⏳ getting your tokens...\nhang tight!'
              : faucetState === 'done'
              ? '✅ 1000 mUSDC dropped!\nnow swap to cUSDC 🔄'
              : faucetState === 'cooldown'
              ? '⏱ already claimed!\ncome back later'
              : 'need mUSDC? 👇\nwrap it → ERC-7984\nconfidential token 🔒'}
          </p>

          {tokenBalance !== null && (
            <div style={{ fontSize: '0.6rem', textAlign: 'center', marginBottom: 8,
              color: faucetState === 'done' ? 'rgba(107,191,122,0.7)' : 'rgba(255,255,255,0.4)',
            }}>
              Balance: {Number(tokenBalance).toFixed(2)} mUSDC
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={handleFaucet}
              disabled={faucetState === 'loading' || !wallet}
              style={{
                background: 'rgba(110,181,255,0.15)',
                border: `1px solid ${faucetState === 'done' ? '#6BBF7A44' : faucetState === 'cooldown' ? 'rgba(255,255,255,0.1)' : 'rgba(110,181,255,0.45)'}`,
                borderRadius: 50, padding: '0.4rem 1rem',
                fontSize: '0.63rem', fontWeight: 700,
                color: faucetState === 'done' ? '#6BBF7A' : faucetState === 'cooldown' ? 'rgba(255,255,255,0.3)' : '#6EB5FF',
                letterSpacing: '0.1em', textTransform: 'uppercase',
                cursor: faucetState === 'loading' || !wallet ? 'wait' : 'pointer',
                pointerEvents: 'auto',
              }}
            >
              {faucetState === 'loading' ? 'CLAIMING...' : faucetState === 'done' ? '✓ CLAIMED!' : faucetState === 'cooldown' ? 'ON COOLDOWN' : 'GET mUSDC'}
            </button>
          </div>
        </div>
        {/* Tail dots — descending toward figurine head */}
        {[
          { size: 14, bottom: -18, left: '50%', ml: -7 },
          { size: 9,  bottom: -30, left: '55%', ml: -4 },
          { size: 5,  bottom: -39, left: '60%', ml: -2 },
        ].map((d, i) => (
          <div key={i} style={{
            position: 'absolute',
            bottom: d.bottom, left: d.left, marginLeft: d.ml,
            width: d.size, height: d.size, borderRadius: '50%',
            background: 'rgba(25,25,38,0.97)',
            border: '1.5px solid rgba(255,255,255,0.15)',
          }} />
        ))}
      </div>

      {/* Modal card — centred */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative',
          marginLeft: '-80px',
          marginTop: '80px',
          width: 390, borderRadius: 18,
            background: '#13131A', border: `1.5px solid ${ACCENT}44`,
            padding: '1.5rem', zIndex: 10,
            boxShadow: '0 20px 40px -10px rgba(0,0,0,0.6)',
            opacity: bubbleVisible ? 1 : 0,
            transition: `opacity 300ms ${EASE}`,
            pointerEvents: 'auto',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              background: `linear-gradient(135deg, ${ACCENT}44, ${ACCENT}88)`,
              border: `1.5px solid ${ACCENT}66`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '1.1rem',
            }}>⇄</div>
            <div>
              <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.1rem', color: 'white', letterSpacing: '0.05em' }}>SWAP TOKENS</div>
              <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>
                mUSDC → cUSDC · Confidential Token
              </div>
            </div>
          </div>

          {/* Info strip */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr',
            gap: 1, borderRadius: 12, overflow: 'hidden', marginBottom: '1.5rem',
            border: '1px solid rgba(255,255,255,0.07)',
          }}>
            {[
              { label: 'FROM', value: 'mUSDC' },
              { label: 'TO', value: 'cUSDC' },
            ].map(item => (
              <div key={item.label} style={{ background: 'rgba(255,255,255,0.04)', padding: '0.75rem 0.85rem' }}>
                <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{item.label}</div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: ACCENT }}>{item.value}</div>
              </div>
            ))}
          </div>

          {step === 'done' ? (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🎉</div>
              <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.2rem', color: '#6BBF7A', letterSpacing: '0.05em', marginBottom: 6 }}>SWAP SUCCESSFUL</div>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)', marginBottom: '1.5rem' }}>
                You now have cUSDC — ready to deposit into the vault!
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
          ) : step === 'approving' || step === 'swapping' ? (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              <div style={{ fontSize: '0.78rem', color: ACCENT, fontWeight: 600, letterSpacing: '0.06em', marginBottom: 8 }}>
                {step === 'approving' ? '⏳ Approving mUSDC...' : '⏳ Wrapping to cUSD...'}
              </div>
              <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', marginTop: 4 }}>
                Confirm in MetaMask if prompted
              </div>
            </div>
          ) : (
            <>
              {/* From input */}
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                  Amount (mUSDC)
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
                      color: 'white', fontSize: '1.1rem', fontWeight: 600, padding: '0.85rem 1rem',
                    }}
                  />
                  <span style={{ padding: '0 1rem', fontSize: '0.75rem', fontWeight: 700, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.08em' }}>
                    mUSDC
                  </span>
                </div>
              </div>

              {/* Arrow */}
              <div style={{ display: 'flex', justifyContent: 'center', margin: '0.5rem 0' }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: `${ACCENT}22`, border: `1.5px solid ${ACCENT}44`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <ArrowDown size={14} color={ACCENT} />
                </div>
              </div>

              {/* To output */}
              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                  You receive (cUSDC)
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center',
                  background: 'rgba(255,255,255,0.03)', border: `1.5px solid ${ACCENT}33`,
                  borderRadius: 12, overflow: 'hidden',
                }}>
                  <div style={{
                    flex: 1, padding: '0.85rem 1rem',
                    fontSize: '1.1rem', fontWeight: 600,
                    color: outAmount === '0.00' ? 'rgba(255,255,255,0.2)' : ACCENT,
                  }}>
                    {outAmount}
                  </div>
                  <span style={{ padding: '0 1rem', fontSize: '0.75rem', fontWeight: 700, color: ACCENT, letterSpacing: '0.08em' }}>
                    cUSDC
                  </span>
                </div>
                <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.25)', marginTop: 5 }}>
                  1 mUSDC = 1 cUSDC · no fees
                </div>
              </div>

              {/* Connected wallet row */}
              {wallet && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'rgba(255,255,255,0.03)', borderRadius: 10,
                  padding: '0.65rem 0.85rem', marginBottom: '1.25rem',
                }}>
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Connected</span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#6BBF7A', fontFamily: 'monospace' }}>
                    {wallet.slice(0, 6)}...{wallet.slice(-4)}
                  </span>
                </div>
              )}

              {/* Swap button */}
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                background: `${ACCENT}11`, border: `1px solid ${ACCENT}33`,
                borderRadius: 10, padding: '0.7rem 0.85rem', marginBottom: '1.25rem',
              }}>
                <span style={{ fontSize: '0.9rem', flexShrink: 0 }}>🔒</span>
                <span style={{ fontSize: '0.67rem', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
                  cUSDC is the confidential version of mUSDC. Fully encrypted via <span style={{ color: '#6EB5FF', fontWeight: 600 }}>Zama FHE</span>.
                </span>
              </div>
              {!wallet ? (
                <div style={{ textAlign: 'center', fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', padding: '0.5rem 0' }}>
                  Connect your wallet to swap
                </div>
              ) : (
                <button
                  onClick={handleSwap}
                  disabled={!amount || Number(amount) <= 0}
                  style={{
                    width: '100%', padding: '0.85rem',
                    background: !amount || Number(amount) <= 0 ? 'rgba(255,255,255,0.06)' : `linear-gradient(135deg, ${ACCENT}, #B85A9A)`,
                    border: 'none', borderRadius: 50,
                    color: !amount || Number(amount) <= 0 ? 'rgba(255,255,255,0.3)' : 'white',
                    fontSize: '0.78rem', fontWeight: 700,
                    letterSpacing: '0.12em', textTransform: 'uppercase',
                    cursor: !amount || Number(amount) <= 0 ? 'not-allowed' : 'pointer',
                    transition: `background 200ms ${EASE}`,
                  }}
                >
                  SWAP NOW
                </button>
              )}
            </>
          )}
        </div>
    </div>
  )
}
