import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrowserProvider, JsonRpcProvider, Contract, formatUnits, getAddress } from 'ethers'
import { ArrowLeft, Shield, Clock, Trophy, Activity, Eye, EyeOff, Wallet, ChevronRight, Lock, Unlock } from 'lucide-react'
import { initSDK, createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/web'
import { ADDRESSES, USDC_ABI, LEDGER_ABI } from './contracts'
import { WithdrawModal } from './WithdrawModal'
import { SimpleSwapModal } from './SimpleSwapModal'
import { DrawModal } from './DrawModal'

const EASE = 'cubic-bezier(0.4,0,0.2,1)'
const RPC  = import.meta.env.VITE_SEPOLIA_RPC_URL as string
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000'

const GRAIN_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E")`

type TxRecord = {
  type: 'deposit' | 'withdraw' | 'faucet'
  amount: string
  hash: string
  block: number
  ts: number
}

type PrizeWin = {
  amount: string
  drawId: number
  hash: string
  ts: number
}

type VaultState = {
  hasDeposit: boolean
  encryptedHandle: string
  mUSDCBalance: string
  totalDeposits: string
  drawCount: number
}

function StatCard({ label, value, icon, color, sub }: { label: string; value: string; icon: React.ReactNode; color: string; sub?: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 16, padding: '1.25rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: '0.6rem' }}>
        <span style={{ color, opacity: 0.85 }}>{icon}</span>
        <span style={{ fontSize: '0.58rem', fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>{label}</span>
      </div>
      <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.8rem', color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.28)', marginTop: 5 }}>{sub}</div>}
    </div>
  )
}

export default function ProfilePage() {
  const navigate = useNavigate()
  const [wallet, setWallet]           = useState<string | null>(null)
  const [visible, setVisible]         = useState(false)
  const [vaultState, setVaultState]   = useState<VaultState | null>(null)
  const [txHistory, setTxHistory]     = useState<TxRecord[]>([])
  const [balanceHidden, setBalanceHidden] = useState(true)
  const [withdrawOpen, setWithdrawOpen]   = useState(false)
  const [loading, setLoading]         = useState(false)
  const [prizeWins, setPrizeWins]     = useState<PrizeWin[]>([])

  type CrackStep = 'idle' | 'cracking' | 'revealed' | 'error'
  const [crackStep, setCrackStep]       = useState<CrackStep>('idle')
  const [crackResult, setCrackResult]   = useState<{ amount: string; net: number } | null>(null)
  const [crackError, setCrackError]     = useState<string | null>(null)
  const [swapOpen, setSwapOpen]         = useState(false)
  const [drawOpen, setDrawOpen]         = useState(false)

  const handleCrack = useCallback(async () => {
    if (!vaultState?.encryptedHandle || vaultState.encryptedHandle === ZERO) return
    if (!wallet) return
    setCrackStep('cracking')
    setCrackResult(null)
    setCrackError(null)
    try {
      // Use BrowserProvider + signer.signTypedData() — matches the README pattern exactly
      const provider = new BrowserProvider((window as any).ethereum)
      const signer = await provider.getSigner()
      const checksumWallet = getAddress(await signer.getAddress())

      await initSDK()
      const instance = await createInstance({
        ...SepoliaConfig,
        network: import.meta.env.VITE_SEPOLIA_RPC_URL,
      })

      const { publicKey, privateKey } = instance.generateKeypair()
      const extraData = await instance.getExtraData()
      const startTimestamp = Math.floor(Date.now() / 1000)
      const durationDays = 1

      const eip712 = instance.createEIP712(
        publicKey,
        [ADDRESSES.ledger],
        startTimestamp,
        durationDays,
        extraData,
      )

      // signTypedData splits domain/types/message — matches vaultshot.ts client exactly
      const signature = await signer.signTypedData(
        eip712.domain,
        { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification as any },
        eip712.message,
      )

      const result = await instance.userDecrypt(
        [{ handle: vaultState.encryptedHandle as `0x${string}`, contractAddress: ADDRESSES.ledger }],
        privateKey,
        publicKey,
        signature.replace('0x', ''),  // SDK expects no 0x prefix
        [ADDRESSES.ledger],
        checksumWallet,
        startTimestamp,
        durationDays,
        extraData,
      )

      const handle = vaultState.encryptedHandle as `0x${string}`
      const raw = BigInt(result[handle] as string | bigint)
      const amount = formatUnits(raw, 6)

      const deposited = txHistory
        .filter(t => t.type === 'deposit')
        .reduce((acc, t) => acc + Number(t.amount), 0)

      setCrackResult({ amount, net: Number(amount) - deposited })
      setCrackStep('revealed')
    } catch (e: any) {
      console.error('crack error:', e?.code, e?.message, e)
      setCrackError(`[${e?.code}] ${e?.message ?? 'Decryption failed'}`)
      setCrackStep('error')
    }
  }, [vaultState, txHistory, wallet])

  // connect wallet
  const connectWallet = useCallback(async () => {
    const eth = (window as any).ethereum
    if (!eth) return
    let accounts: string[] = await eth.request({ method: 'eth_accounts' })
    if (!accounts.length) {
      for (let i = 0; i < 10; i++) {
        try { accounts = await eth.request({ method: 'eth_requestAccounts' }); break }
        catch (e: any) { if (e?.code === -32002) await new Promise(r => setTimeout(r, 2000)); else throw e }
      }
    }
    if (accounts.length) setWallet(accounts[0])
  }, [])

  useEffect(() => {
    const eth = (window as any).ethereum
    if (!eth) return
    eth.request({ method: 'eth_accounts' }).then((a: string[]) => { if (a.length) setWallet(a[0]) })
    const onChange = (a: string[]) => { if (a.length) setWallet(a[0]) }
    eth.on('accountsChanged', onChange)
    return () => eth.removeListener('accountsChanged', onChange)
  }, [])

  const loadData = useCallback(async (addr: string) => {
    setLoading(true)
    try {
      const provider = new JsonRpcProvider(RPC, 11155111, { staticNetwork: true })
      const token    = new Contract(ADDRESSES.usdc,   USDC_ABI,   provider)
      const ledger   = new Contract(ADDRESSES.ledger, LEDGER_ABI, provider)

      const [handle, mUSDCBal, drawCount] = await Promise.all([
        ledger.confidentialBalanceOf(addr)     as Promise<string>,
        token.balanceOf(addr)                  as Promise<bigint>,
        // drawCount lives on prize pool
        new Contract(ADDRESSES.prizePool, ['function drawCount() view returns (uint256)'], provider)
          .drawCount().catch(() => 0n)          as Promise<bigint>,
      ])

      const hasDeposit = handle !== ZERO

      setVaultState({
        hasDeposit,
        encryptedHandle: handle,
        mUSDCBalance: formatUnits(mUSDCBal, 6),
        totalDeposits: '—',
        drawCount: Number(drawCount),
      })

      // Fetch Transfer events involving this wallet ↔ vault (deposit/withdraw history)
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
      const addrPadded    = '0x000000000000000000000000' + addr.slice(2).toLowerCase()
      const vaultPadded   = '0x000000000000000000000000' + ADDRESSES.vault.slice(2).toLowerCase()

      const [depositsRaw, withdrawsRaw, faucetsRaw, prizeRaw] = await Promise.all([
        // deposits: Transfer from wallet → vault (token contract)
        provider.getLogs({ address: ADDRESSES.usdc, fromBlock: 11600000, toBlock: 'latest',
          topics: [transferTopic, addrPadded, vaultPadded] }),
        // withdraws: Transfer from vault → wallet (token contract)
        provider.getLogs({ address: ADDRESSES.usdc, fromBlock: 11600000, toBlock: 'latest',
          topics: [transferTopic, vaultPadded, addrPadded] }),
        // faucet mints: Transfer from 0x0 → wallet
        provider.getLogs({ address: ADDRESSES.usdc, fromBlock: 11600000, toBlock: 'latest',
          topics: [transferTopic, '0x0000000000000000000000000000000000000000000000000000000000000000', addrPadded] }),
        // prize payouts: Transfer from prizePool → wallet
        provider.getLogs({ address: ADDRESSES.usdc, fromBlock: 11600000, toBlock: 'latest',
          topics: [transferTopic, '0x000000000000000000000000' + ADDRESSES.prizePool.slice(2).toLowerCase(), addrPadded] }),
      ])

      const decodeAmount = (log: any) =>
        formatUnits(BigInt('0x' + log.data.slice(2).padStart(64, '0')), 6)

      const blockTimes: Record<number, number> = {}
      const getBlockTs = async (bn: number) => {
        if (blockTimes[bn]) return blockTimes[bn]
        const b = await provider.getBlock(bn)
        blockTimes[bn] = b?.timestamp ?? 0
        return blockTimes[bn]
      }

      const allLogs = [
        ...depositsRaw.map(l => ({ ...l, kind: 'deposit' as const })),
        ...withdrawsRaw.map(l => ({ ...l, kind: 'withdraw' as const })),
        ...faucetsRaw.map(l => ({ ...l, kind: 'faucet' as const })),
      ].sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0))

      // prize wins — DrawExecuted topic for draw ID correlation (best-effort)
      const DRAW_EXECUTED = '0xa765c1807b033c566a5ab6f44ecc37bbdd9c8b5c02a7ee01a2dac2e11f265aaf'
      const drawLogs = await provider.getLogs({
        address: ADDRESSES.prizePool, fromBlock: 11600000, toBlock: 'latest',
        topics: [DRAW_EXECUTED],
      }).catch(() => [])

      const wins: PrizeWin[] = await Promise.all(
        prizeRaw.map(async (log, idx) => {
          const ts = await getBlockTs(log.blockNumber ?? 0)
          // find the DrawExecuted log closest in block number (≤ win block)
          const drawLog = [...drawLogs]
            .filter(d => (d.blockNumber ?? 0) <= (log.blockNumber ?? 0))
            .sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0))[0]
          const drawId = drawLog
            ? Number(BigInt('0x' + (drawLog.topics[1]?.slice(2) ?? '0').padStart(64, '0')))
            : idx + 1
          return {
            amount: decodeAmount(log),
            drawId,
            hash: log.transactionHash,
            ts,
          }
        })
      )
      wins.sort((a, b) => b.ts - a.ts)
      setPrizeWins(wins)

      const records: TxRecord[] = await Promise.all(
        allLogs.slice(0, 30).map(async l => ({
          type: l.kind,
          amount: decodeAmount(l),
          hash: l.transactionHash,
          block: l.blockNumber ?? 0,
          ts: await getBlockTs(l.blockNumber ?? 0),
        }))
      )

      setTxHistory(records)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (wallet) loadData(wallet) }, [wallet, loadData])
  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t) }, [])

  const formatTs = (ts: number) => {
    if (!ts) return '—'
    const d = new Date(ts * 1000)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' +
           d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  }

  const txTypeColor = { deposit: '#6EB5FF', withdraw: '#F4845F', faucet: '#6BBF7A' }
  const txTypeLabel = { deposit: 'DEPOSIT', withdraw: 'WITHDRAW', faucet: 'FAUCET' }

  return (
    <>
    <div style={{ minHeight: '100vh', background: '#0F0F14', fontFamily: "'Inter', sans-serif", position: 'relative', overflowX: 'hidden' }}>
      {/* Grain */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 50, backgroundImage: GRAIN_SVG, backgroundSize: '200px 200px', backgroundRepeat: 'repeat', opacity: 0.4 }} aria-hidden />

      {/* Blobs */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', width: 600, height: 600, borderRadius: '50%', background: 'radial-gradient(circle, #6EB5FF10 0%, transparent 65%)', top: -200, right: -100 }} />
        <div style={{ position: 'absolute', width: 400, height: 400, borderRadius: '50%', background: 'radial-gradient(circle, #E882B410 0%, transparent 65%)', bottom: 0, left: -100 }} />
      </div>

      {/* Nav */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '1.5rem 2.5rem',
        opacity: visible ? 1 : 0, transition: `opacity 500ms ${EASE}`,
      }}>
        <button onClick={() => navigate('/deposit')} style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          background: 'rgba(255,255,255,0.06)', border: '1.5px solid rgba(255,255,255,0.14)',
          borderRadius: 50, padding: '0.6rem 1.2rem',
          color: 'white', fontSize: '0.72rem', fontWeight: 700,
          letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
        }}>
          <ArrowLeft size={14} /> Vaults
        </button>

        <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontFamily: "'Anton', sans-serif", fontSize: '1.05rem', letterSpacing: '0.2em', color: 'white', textTransform: 'uppercase' }}>
          MY PORTFOLIO
        </span>

        {wallet ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(107,191,122,0.1)', border: '1.5px solid rgba(107,191,122,0.3)', borderRadius: 50, padding: '0.45rem 1rem' }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#6BBF7A', boxShadow: '0 0 8px #6BBF7A' }} />
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#6BBF7A', letterSpacing: '0.08em', fontFamily: 'monospace' }}>
              {wallet.slice(0, 6)}...{wallet.slice(-4)}
            </span>
          </div>
        ) : (
          <button onClick={connectWallet} style={{
            background: 'rgba(244,132,95,0.08)', border: '1.5px solid #F4845F',
            borderRadius: 50, padding: '0.45rem 1rem',
            color: '#F4845F', fontSize: '0.68rem', fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
          }}>CONNECT WALLET</button>
        )}
      </div>

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 900, margin: '0 auto', padding: '7rem 2rem 5rem' }}>

        {!wallet ? (
          /* ── No wallet ── */
          <div style={{
            textAlign: 'center', padding: '6rem 2rem',
            opacity: visible ? 1 : 0, transition: `opacity 600ms ${EASE}`,
          }}>
            <Wallet size={48} color="rgba(255,255,255,0.15)" style={{ marginBottom: '1.5rem' }} />
            <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.4rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.06em', marginBottom: '0.75rem' }}>
              NO WALLET CONNECTED
            </div>
            <p style={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.82rem', marginBottom: '2rem' }}>
              Connect your wallet to view your portfolio
            </p>
            <button onClick={connectWallet} style={{
              background: '#F4845F', border: 'none', borderRadius: 50,
              padding: '0.85rem 2.5rem', color: '#0A0A0F',
              fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.12em',
              textTransform: 'uppercase', cursor: 'pointer',
            }}>CONNECT WALLET</button>
          </div>
        ) : loading ? (
          /* ── Loading ── */
          <div style={{ textAlign: 'center', padding: '6rem 2rem', color: 'rgba(255,255,255,0.3)', fontSize: '0.82rem' }}>
            Loading on-chain data...
          </div>
        ) : (
          <>
            {/* ── Wallet header ── */}
            <div style={{
              marginBottom: '2rem',
              opacity: visible ? 1 : 0, transform: visible ? 'translateY(0)' : 'translateY(16px)',
              transition: `opacity 600ms ${EASE} 80ms, transform 600ms ${EASE} 80ms`,
            }}>
              <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 6 }}>
                WALLET
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontFamily: 'monospace', fontSize: '1rem', color: 'white', letterSpacing: '0.04em' }}>
                  {wallet}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setSwapOpen(true)} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'linear-gradient(135deg, rgba(232,130,180,0.15), rgba(110,181,255,0.1))',
                  border: '1.5px solid rgba(232,130,180,0.4)',
                  borderRadius: 50, padding: '0.38rem 0.9rem',
                  color: '#E882B4', fontSize: '0.68rem', fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer', flexShrink: 0,
                }}>
                  <span style={{ fontSize: '0.85rem' }}>⇄</span> SWAP
                </button>
                <button onClick={() => setDrawOpen(true)} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'linear-gradient(135deg, rgba(255,215,0,0.12), rgba(255,165,0,0.08))',
                  border: '1.5px solid rgba(255,200,0,0.4)',
                  borderRadius: 50, padding: '0.38rem 0.9rem',
                  color: '#FFD700', fontSize: '0.68rem', fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer', flexShrink: 0,
                }}>
                  🎲 DRAW
                </button>
                </div>
              </div>
            </div>

            {/* ── Winner banner ── */}
            {prizeWins.length > 0 && (
              <div style={{
                marginBottom: '2rem',
                opacity: visible ? 1 : 0,
                transform: visible ? 'translateY(0)' : 'translateY(-10px)',
                transition: `opacity 600ms ${EASE} 60ms, transform 600ms ${EASE} 60ms`,
              }}>
                {prizeWins.map((win, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    background: 'linear-gradient(135deg, rgba(255,197,61,0.10) 0%, rgba(232,130,180,0.08) 100%)',
                    border: '1.5px solid rgba(255,197,61,0.35)',
                    borderRadius: 16, padding: '1.1rem 1.4rem',
                    marginBottom: prizeWins.length > 1 && i < prizeWins.length - 1 ? '0.75rem' : 0,
                    boxShadow: '0 0 32px rgba(255,197,61,0.08)',
                  }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                      background: 'linear-gradient(135deg, rgba(255,197,61,0.25), rgba(232,130,180,0.2))',
                      border: '1.5px solid rgba(255,197,61,0.4)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '1.4rem',
                    }}>🏆</div>
                    <div style={{ flex: 1 }}>
                      <div style={{
                        fontFamily: "'Anton', sans-serif", fontSize: '0.95rem',
                        color: '#FFC53D', letterSpacing: '0.07em', marginBottom: 4,
                      }}>
                        YOU WON {Number(win.amount).toFixed(2)} mUSDC
                      </div>
                      <div style={{ fontSize: '0.67rem', color: 'rgba(255,255,255,0.45)', lineHeight: 1.4 }}>
                        Draw #{win.drawId} prize — funds already in your wallet
                        {win.ts > 0 && (
                          <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.28)' }}>
                            · {formatTs(win.ts)}
                          </span>
                        )}
                      </div>
                    </div>
                    <a
                      href={`https://sepolia.etherscan.io/tx/${win.hash}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{
                        fontSize: '0.62rem', fontWeight: 700, color: '#FFC53D',
                        textDecoration: 'none', letterSpacing: '0.08em',
                        background: 'rgba(255,197,61,0.1)', border: '1px solid rgba(255,197,61,0.3)',
                        borderRadius: 6, padding: '4px 10px', whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,197,61,0.2)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,197,61,0.1)')}
                    >
                      VIEW TX ↗
                    </a>
                  </div>
                ))}
              </div>
            )}

            {/* ── Stats grid ── */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.85rem',
              marginBottom: '2rem',
              opacity: visible ? 1 : 0, transition: `opacity 600ms ${EASE} 140ms`,
            }}>
              <StatCard label="mUSDC Balance" value={Number(vaultState?.mUSDCBalance ?? 0).toFixed(2)} icon={<Shield size={15} />} color="#6EB5FF" sub="in wallet" />
              <StatCard label="Vault Deposits" value={vaultState?.hasDeposit ? 'ACTIVE' : 'NONE'} icon={<Activity size={15} />} color={vaultState?.hasDeposit ? '#6BBF7A' : 'rgba(255,255,255,0.3)'} sub={vaultState?.hasDeposit ? 'encrypted on-chain' : 'no active position'} />
              <StatCard label="Draws Completed" value={String(vaultState?.drawCount ?? 0)} icon={<Trophy size={15} />} color="#F4845F" sub="total draws run" />
              <StatCard label="Pool Total" value={vaultState?.totalDeposits ?? '—'} icon={<Clock size={15} />} color="#E882B4" sub="mUSDC in vault" />
            </div>

            {/* ── Active vault position ── */}
            <div style={{
              marginBottom: '2rem',
              opacity: visible ? 1 : 0, transition: `opacity 600ms ${EASE} 200ms`,
            }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: '1rem' }}>
                VAULT POSITION
              </div>

              <div style={{
                borderRadius: 18, border: `1.5px solid ${vaultState?.hasDeposit ? '#6EB5FF33' : 'rgba(255,255,255,0.07)'}`,
                background: vaultState?.hasDeposit ? 'rgba(110,181,255,0.04)' : 'rgba(255,255,255,0.02)',
                padding: '1.5rem',
              }}>
                {vaultState?.hasDeposit ? (
                  <>
                    {/* Vault header */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                          background: 'linear-gradient(135deg, #6EB5FF44, #6EB5FF88)',
                          border: '1.5px solid #6EB5FF66',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontFamily: "'Anton', sans-serif", fontSize: '0.75rem', color: '#6EB5FF',
                        }}>US</div>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '1rem', color: 'white', marginBottom: 3 }}>mUSDC Vault</div>
                          <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            Confidential Vault · Zama FHE · 5 Min Draws
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => navigate('/deposit')}
                          style={{
                            padding: '0.55rem 1.1rem', borderRadius: 50,
                            background: 'transparent', border: '1.5px solid #6EB5FF',
                            color: '#6EB5FF', fontSize: '0.7rem', fontWeight: 700,
                            letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}>
                          DEPOSIT <ChevronRight size={12} />
                        </button>
                        <button
                          onClick={() => setWithdrawOpen(true)}
                          style={{
                            padding: '0.55rem 1.1rem', borderRadius: 50,
                            background: '#F4845F', border: 'none',
                            color: '#0A0A0F', fontSize: '0.7rem', fontWeight: 700,
                            letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
                          }}>
                          WITHDRAW
                        </button>
                      </div>
                    </div>

                    {/* Balance + crack side by side */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                      {/* Encrypted balance */}
                      <div style={{
                        flex: 1,
                        background: 'rgba(255,255,255,0.04)', borderRadius: 12,
                        padding: '1rem 1.1rem', border: '1px solid rgba(255,255,255,0.07)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                            ENCRYPTED BALANCE
                          </span>
                          <button onClick={() => setBalanceHidden(h => !h)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.35)', padding: 0, display: 'flex' }}>
                            {balanceHidden ? <Eye size={13} /> : <EyeOff size={13} />}
                          </button>
                        </div>
                        <div style={{ fontSize: balanceHidden ? '1.4rem' : '0.65rem', fontFamily: balanceHidden ? "'Anton', sans-serif" : 'monospace', color: '#6EB5FF', letterSpacing: balanceHidden ? '0.1em' : '0.02em', wordBreak: 'break-all', lineHeight: 1.4 }}>
                          {balanceHidden ? '•••• mUSDC' : vaultState.encryptedHandle}
                        </div>
                        {balanceHidden && (
                          <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.2)', marginTop: 6 }}>
                            click eye to reveal ciphertext handle
                          </div>
                        )}
                      </div>

                      {/* ── CRACK THE VAULT ── */}
                      <div style={{ display: 'flex', alignItems: 'stretch', justifyContent: 'center' }}>
                      {crackStep === 'idle' && (
                        <button
                          onClick={handleCrack}
                          style={{
                            width: '100%', height: '100%',
                            background: 'linear-gradient(135deg, #7B5EA7, #4C3F8A)',
                            border: '1.5px solid rgba(155,120,255,0.45)',
                            borderRadius: 12, color: 'white',
                            fontSize: '0.75rem', fontWeight: 700,
                            letterSpacing: '0.12em', textTransform: 'uppercase',
                            cursor: 'pointer', display: 'flex', alignItems: 'center',
                            justifyContent: 'center', gap: 8,
                            boxShadow: '0 0 24px rgba(123,94,167,0.3)',
                            transition: 'box-shadow 200ms, opacity 200ms',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 40px rgba(123,94,167,0.55)')}
                          onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 0 24px rgba(123,94,167,0.3)')}
                        >
                          <Lock size={15} /> CRACK THE VAULT
                        </button>
                      )}

                      {(crackStep === 'cracking') && (
                        <div style={{
                          padding: '0.9rem 1.2rem',
                          background: 'rgba(123,94,167,0.1)',
                          border: '1.5px solid rgba(155,120,255,0.3)',
                          borderRadius: 50, textAlign: 'center', whiteSpace: 'nowrap',
                        }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#B899FF', letterSpacing: '0.12em', marginBottom: 4 }}>
                            CRACKING...
                          </div>
                          <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.06em' }}>
                            ~10-20s
                          </div>
                        </div>
                      )}

                      {crackStep === 'revealed' && crackResult && (
                        <div style={{
                          background: crackResult.net > 0
                            ? 'linear-gradient(135deg, rgba(107,191,122,0.1), rgba(255,197,61,0.07))'
                            : 'rgba(123,94,167,0.08)',
                          border: `1.5px solid ${crackResult.net > 0 ? 'rgba(107,191,122,0.4)' : 'rgba(155,120,255,0.35)'}`,
                          borderRadius: 16, padding: '1rem 1.1rem',
                          display: 'flex', alignItems: 'center', gap: 10,
                        }}>
                          <div style={{
                            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                            background: crackResult.net > 0 ? 'rgba(107,191,122,0.15)' : 'rgba(123,94,167,0.2)',
                            border: `1.5px solid ${crackResult.net > 0 ? 'rgba(107,191,122,0.4)' : 'rgba(155,120,255,0.3)'}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '1rem',
                          }}>
                            {crackResult.net > 0 ? '🏆' : <Unlock size={15} color="#B899FF" />}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{
                              fontFamily: "'Anton', sans-serif", fontSize: '1.1rem',
                              color: crackResult.net > 0 ? '#6BBF7A' : '#B899FF',
                              letterSpacing: '0.06em', lineHeight: 1,
                            }}>
                              {Number(crackResult.amount).toFixed(2)} mUSDC
                            </div>
                            <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                              {crackResult.net > 0
                                ? `+${crackResult.net.toFixed(2)} prize!`
                                : 'vault balance'}
                            </div>
                          </div>
                          <button
                            onClick={() => setCrackStep('idle')}
                            style={{
                              fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.08em',
                              color: 'rgba(255,255,255,0.35)', background: 'none',
                              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6,
                              padding: '4px 10px', cursor: 'pointer',
                            }}
                          >RESET</button>
                        </div>
                      )}

                      {crackStep === 'error' && (
                        <div style={{
                          background: 'rgba(244,132,95,0.07)', border: '1.5px solid rgba(244,132,95,0.3)',
                          borderRadius: 12, padding: '0.85rem 1rem',
                          display: 'flex', alignItems: 'center', gap: 10,
                        }}>
                          <div style={{ fontSize: '0.67rem', color: '#F4845F', wordBreak: 'break-word', flex: 1 }}>
                            {crackError}
                          </div>
                          <button
                            onClick={() => { setCrackStep('idle'); setCrackError(null) }}
                            style={{
                              fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.08em',
                              color: '#F4845F', background: 'rgba(244,132,95,0.1)',
                              border: '1px solid rgba(244,132,95,0.3)', borderRadius: 6,
                              padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
                            }}
                          >TRY AGAIN</button>
                        </div>
                      )}
                      </div>
                    </div>

                    {/* FHE info banner */}
                    <div style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                      background: 'rgba(110,181,255,0.06)', border: '1px solid rgba(110,181,255,0.2)',
                      borderRadius: 10, padding: '0.75rem 1rem',
                    }}>
                      <Shield size={13} color="#6EB5FF" style={{ flexShrink: 0, marginTop: 1 }} />
                      <span style={{ fontSize: '0.67rem', color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>
                        Your balance is stored as a Zama FHE ciphertext. Nobody — not even the contract — can read it without the Zama Relayer decryption proof. The handle above is the on-chain encrypted reference.
                      </span>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '2rem' }}>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.25)', marginBottom: '1.25rem' }}>
                      No active vault position
                    </div>
                    <button onClick={() => navigate('/deposit')} style={{
                      background: '#6EB5FF', border: 'none', borderRadius: 50,
                      padding: '0.75rem 2rem', color: '#0A0A0F',
                      fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.12em',
                      textTransform: 'uppercase', cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}>
                      DEPOSIT NOW <ChevronRight size={13} />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* ── Transaction history ── */}
            <div style={{ opacity: visible ? 1 : 0, transition: `opacity 600ms ${EASE} 280ms` }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: '1rem' }}>
                TRANSACTION HISTORY
              </div>

              {txHistory.length === 0 ? (
                <div style={{
                  borderRadius: 14, border: '1px solid rgba(255,255,255,0.07)',
                  background: 'rgba(255,255,255,0.02)', padding: '2.5rem',
                  textAlign: 'center', color: 'rgba(255,255,255,0.2)', fontSize: '0.82rem',
                }}>
                  No transactions found for this wallet
                </div>
              ) : (
                <div style={{ borderRadius: 14, border: '1px solid rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                  {/* Header row */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: '80px 1fr 100px 200px',
                    padding: '0.65rem 1.25rem',
                    background: 'rgba(255,255,255,0.03)',
                    fontSize: '0.58rem', fontWeight: 700, color: 'rgba(255,255,255,0.25)',
                    letterSpacing: '0.14em', textTransform: 'uppercase',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                  }}>
                    <span>Type</span><span>Tx Hash</span><span style={{ textAlign: 'right' }}>Amount</span><span style={{ textAlign: 'right' }}>Date</span>
                  </div>

                  {txHistory.map((tx, i) => (
                    <div key={i} style={{
                      display: 'grid', gridTemplateColumns: '80px 1fr 100px 200px',
                      padding: '0.85rem 1.25rem', alignItems: 'center',
                      borderBottom: i < txHistory.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                    }}>
                      <span style={{
                        fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.1em',
                        color: txTypeColor[tx.type],
                        background: txTypeColor[tx.type] + '18',
                        border: `1px solid ${txTypeColor[tx.type]}33`,
                        borderRadius: 4, padding: '3px 7px', display: 'inline-block',
                      }}>
                        {txTypeLabel[tx.type]}
                      </span>

                      <a
                        href={`https://sepolia.etherscan.io/tx/${tx.hash}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'rgba(255,255,255,0.45)', textDecoration: 'none' }}
                        onMouseEnter={e => (e.currentTarget.style.color = 'white')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.45)')}
                      >
                        {tx.hash.slice(0, 12)}...{tx.hash.slice(-6)}
                      </a>

                      <span style={{ textAlign: 'right', fontSize: '0.78rem', fontWeight: 600, color: txTypeColor[tx.type] }}>
                        {tx.type === 'deposit' ? '-' : '+'}{Number(tx.amount).toFixed(2)} mUSDC
                      </span>

                      <span style={{ textAlign: 'right', fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>
                        {formatTs(tx.ts)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>

    {withdrawOpen && wallet && (
      <WithdrawModal
        wallet={wallet}
        vaultColor="#6EB5FF"
        onClose={() => setWithdrawOpen(false)}
        onWithdrawn={() => { setWithdrawOpen(false); loadData(wallet) }}
      />
    )}
    {swapOpen && (
      <SimpleSwapModal wallet={wallet} onClose={() => setSwapOpen(false)} />
    )}
    {drawOpen && (
      <DrawModal onClose={() => { setDrawOpen(false); if (wallet) loadData(wallet) }} />
    )}
    </>
  )
}
