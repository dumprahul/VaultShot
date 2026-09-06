import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrowserProvider, Contract, formatUnits, getAddress } from 'ethers'
import { ArrowLeft, Search, TrendingUp, Users, Trophy, Zap, ChevronRight, Star, X, Lock } from 'lucide-react'
import { createInstance, initSDK, SepoliaConfig } from '@zama-fhe/relayer-sdk/web'
import { ADDRESSES, VAULT_ABI } from './contracts'
import { SwapModal } from './SwapModal'

const EASE = 'cubic-bezier(0.4,0,0.2,1)'
const DURATION = 650

const VAULTS = [
  { id: 1, name: 'cUSDC Vault', token: 'cUSDC', bg: '#6EB5FF', drawPeriod: '5 min',  grandPrize: '700',    totalDeposits: '—',         tag: 'DEMO POOL',     drawPeriodLabel: '5 MIN DRAWS' },
  { id: 2, name: 'DAI Vault',   token: 'DAI',  bg: '#F4845F', drawPeriod: '24 hr',  grandPrize: '6,244',  totalDeposits: '1,780,000', tag: 'HIGHEST APY',   drawPeriodLabel: 'DAILY DRAWS' },
  { id: 3, name: 'WETH Vault',  token: 'WETH', bg: '#6BBF7A', drawPeriod: '30 days',grandPrize: '12,845', totalDeposits: '3,220,000', tag: 'LARGEST PRIZE', drawPeriodLabel: 'MONTHLY DRAWS' },
  { id: 4, name: 'WBTC Vault',  token: 'WBTC', bg: '#E882B4', drawPeriod: '30 days',grandPrize: '14,735', totalDeposits: '4,100,000', tag: null,            drawPeriodLabel: 'MONTHLY DRAWS' },
  { id: 5, name: 'USDT Vault',  token: 'USDT', bg: '#6BBF7A', drawPeriod: '24 hr',  grandPrize: '4,820',  totalDeposits: '2,100,000', tag: null,            drawPeriodLabel: 'DAILY DRAWS' },
  { id: 6, name: 'LINK Vault',  token: 'LINK', bg: '#6EB5FF', drawPeriod: '24 hr',  grandPrize: '9,310',  totalDeposits: '1,540,000', tag: null,            drawPeriodLabel: 'DAILY DRAWS' },
  { id: 7, name: 'UNI Vault',   token: 'UNI',  bg: '#E882B4', drawPeriod: '30 days',grandPrize: '18,200', totalDeposits: '2,860,000', tag: null,            drawPeriodLabel: 'MONTHLY DRAWS' },
]

const STATS = [
  { label: 'TOTAL DEPOSITED',   value: '$9.1M',    icon: <TrendingUp size={16} />, color: '#6EB5FF' },
  { label: 'ACTIVE DEPOSITORS', value: '2,847',    icon: <Users size={16} />,      color: '#6BBF7A' },
  { label: 'GRAND PRIZE',       value: '700 USDC', icon: <Trophy size={16} />,     color: '#F4845F' },
  { label: 'DRAWS COMPLETED',   value: '312',      icon: <Zap size={16} />,        color: '#E882B4' },
]

const TIPS = [
  { text: 'Yo... this vault is encrypted??\nNobody can see my balance?? 👀' },
  { text: 'Wait— my money earns yield\nAND I could win the prize pool?? 🤯' },
  { text: 'Principal always safe.\nNo loss. Ever. That\'s wild 🔒' },
]

const GRAIN_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E")`

// ── Thought bubble ────────────────────────────────────────────────────────────
function ThoughtBubble({ visible }: { visible: boolean }) {
  const [tipIndex, setTipIndex] = useState(0)
  const [textVisible, setTextVisible] = useState(true)

  useEffect(() => {
    if (!visible) return
    const id = setInterval(() => {
      setTextVisible(false)
      setTimeout(() => {
        setTipIndex(i => (i + 1) % TIPS.length)
        setTextVisible(true)
      }, 350)
    }, 5500)
    return () => clearInterval(id)
  }, [visible])

  return (
    <div style={{
      position: 'relative',
      width: 260,
      opacity: visible ? 1 : 0,
      transform: visible ? 'scale(1)' : 'scale(0.4)',
      transformOrigin: 'bottom center',
      transition: `opacity 700ms ${EASE} 1000ms, transform 700ms cubic-bezier(0.34,1.6,0.64,1) 1000ms`,
      pointerEvents: 'none',
      marginBottom: 8,
    }}>
      {/* Main bubble */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(25,25,38,0.97) 0%, rgba(18,18,30,0.97) 100%)',
        border: '1.5px solid rgba(255,255,255,0.15)',
        borderRadius: 24,
        padding: '22px 26px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1), 0 0 0 1px rgba(244,132,95,0.1)',
        position: 'relative',
        minHeight: 160,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {/* Decorative corner accent */}
        <div style={{
          position: 'absolute', top: -1, left: -1,
          width: 40, height: 40,
          borderTop: '2px solid #F4845F88',
          borderLeft: '2px solid #F4845F88',
          borderRadius: '24px 0 0 0',
        }} />
        <div style={{
          position: 'absolute', bottom: -1, right: -1,
          width: 30, height: 30,
          borderBottom: '2px solid #6EB5FF44',
          borderRight: '2px solid #6EB5FF44',
          borderRadius: '0 0 24px 0',
        }} />

        <div style={{
          textAlign: 'center',
          opacity: textVisible ? 1 : 0,
          transform: textVisible ? 'translateY(0) scale(1)' : 'translateY(4px) scale(0.97)',
          transition: 'opacity 350ms ease, transform 350ms ease',
        }}>
          <p style={{
            margin: 0,
            fontSize: '0.82rem',
            fontWeight: 600,
            color: 'white',
            lineHeight: 1.5,
            letterSpacing: '0.01em',
            whiteSpace: 'pre-line',
          }}>
            {TIPS[tipIndex].text}
          </p>
        </div>

        {/* Step counter */}
        <div style={{
          position: 'absolute', top: 8, right: 10,
          fontSize: '0.52rem', fontWeight: 700,
          color: 'rgba(255,255,255,0.25)',
          letterSpacing: '0.1em',
        }}>
          {tipIndex + 1}/{TIPS.length}
        </div>
      </div>

      {/* Tail dots — pointing down toward the figurine's head */}
      {[
        { size: 14, bottom: -18, left: '50%', ml: -7 },
        { size: 9,  bottom: -30, left: '55%', ml: -4 },
        { size: 5,  bottom: -39, left: '60%', ml: -2 },
      ].map((d, i) => (
        <div key={i} style={{
          position: 'absolute',
          bottom: d.bottom, left: d.left,
          marginLeft: d.ml,
          width: d.size, height: d.size,
          borderRadius: '50%',
          background: 'rgba(25,25,38,0.97)',
          border: '1.5px solid rgba(255,255,255,0.15)',
        }} />
      ))}
    </div>
  )
}

// ── Vault row ─────────────────────────────────────────────────────────────────
function VaultRow({ vault, index, onDeposit, totalDepositsOverride }: { vault: typeof VAULTS[0]; index: number; onDeposit: () => void; totalDepositsOverride?: string | null }) {
  const [visible, setVisible] = useState(false)
  const [hovered, setHovered] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 200 + index * 120)
    return () => clearTimeout(t)
  }, [index])

  return (
    <div
      ref={ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr 150px',
        alignItems: 'center',
        gap: '1rem',
        padding: '1.1rem 1.5rem',
        borderRadius: 14,
        background: hovered ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.025)',
        border: `1px solid ${hovered ? vault.bg + '55' : 'rgba(255,255,255,0.07)'}`,
        marginBottom: '0.65rem',
        cursor: 'pointer',
        transition: `opacity ${DURATION}ms ${EASE}, transform ${DURATION}ms ${EASE}, background 200ms ${EASE}, border-color 200ms ${EASE}`,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(20px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
        <div style={{
          width: 42, height: 42, borderRadius: 11, flexShrink: 0,
          background: `linear-gradient(135deg, ${vault.bg}44, ${vault.bg}88)`,
          border: `1.5px solid ${vault.bg}66`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontFamily: "'Anton', sans-serif", fontSize: '0.75rem', color: 'white', letterSpacing: '0.04em' }}>
            {vault.token.slice(0, 2)}
          </span>
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: 3 }}>
            <span style={{ fontWeight: 700, fontSize: '0.92rem', color: 'white' }}>{vault.name}</span>
            {vault.tag && (
              <span style={{
                fontSize: '0.52rem', fontWeight: 700, letterSpacing: '0.1em',
                color: vault.bg, border: `1px solid ${vault.bg}55`,
                borderRadius: 4, padding: '2px 6px', textTransform: 'uppercase',
              }}>{vault.tag}</span>
            )}
          </div>
          <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Confidential Vault · Zama FHE · {vault.drawPeriodLabel}
          </span>
        </div>
      </div>

      <div>
        <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.2rem', color: vault.bg, lineHeight: 1 }}>{vault.grandPrize} <span style={{ fontSize: '0.75rem' }}>USDC</span></div>
        <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>Grand Prize</div>
      </div>

      <div>
        <div style={{ fontSize: '0.92rem', fontWeight: 600, color: 'rgba(255,255,255,0.88)', lineHeight: 1 }}>
          {totalDepositsOverride !== undefined ? (totalDepositsOverride ?? '…') : vault.totalDeposits}
        </div>
        <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>Total Deposited</div>
      </div>

      <div>
        <div style={{ fontSize: '0.92rem', fontWeight: 600, color: vault.bg, lineHeight: 1 }}>{vault.drawPeriod}</div>
        <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>Draw Every</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button onClick={onDeposit} style={{
          padding: '0.55rem 1.1rem', borderRadius: 50,
          background: hovered ? vault.bg : 'transparent',
          border: `1.5px solid ${vault.bg}`,
          color: hovered ? '#0A0A0F' : vault.bg,
          fontSize: '0.7rem', fontWeight: 700,
          letterSpacing: '0.1em', textTransform: 'uppercase',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
          transition: `background 200ms ${EASE}, color 200ms ${EASE}`,
          whiteSpace: 'nowrap',
        }}>
          DEPOSIT <ChevronRight size={12} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  )
}

// ── Deposit Modal ─────────────────────────────────────────────────────────────
type VaultType = typeof VAULTS[number]

// Polls eth_getTransactionReceipt until the tx is mined
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

// Sends a tx and handles MetaMask 4100 by polling nonce instead of relying on the hash.
// MetaMask throws 4100 but still shows the popup and submits the tx — nonce increment = confirmed.
async function sendTx(eth: any, params: Record<string, string>): Promise<string | null> {
  // Snapshot confirmed nonce BEFORE sending so we can detect when THIS tx lands
  const nonceBefore = parseInt(
    await eth.request({ method: 'eth_getTransactionCount', params: [params.from, 'latest'] }), 16
  )
  try {
    return await eth.request({ method: 'eth_sendTransaction', params: [params] })
  } catch (e: any) {
    if (e?.code === 4100) {
      // MetaMask showed the popup but threw 4100 — poll until confirmed nonce exceeds our snapshot
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const nonceNow = parseInt(
          await eth.request({ method: 'eth_getTransactionCount', params: [params.from, 'latest'] }), 16
        )
        if (nonceNow > nonceBefore) return null
      }
      throw new Error('timed out waiting for nonce increment after 4100')
    }
    throw e
  }
}

function DepositModal({ vault, wallet, onClose, onDeposited }: { vault: VaultType; wallet: string | null; onClose: () => void; onDeposited: () => void }) {
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<'input' | 'operator' | 'encrypting' | 'depositing' | 'done' | 'error'>('input')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [bubbleVisible, setBubbleVisible] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setBubbleVisible(true), 400)
    return () => clearTimeout(t)
  }, [])

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleDeposit = async () => {
    if (!amount || Number(amount) <= 0 || !wallet) return

    const address = wallet
    const rawAmount = BigInt(Math.floor(Number(amount) * 1_000_000))
    const eth = (window as any).ethereum

    try {
      // Step 1: setOperator(vault, type(uint48).max) on cUSD so vault can pull our balance
      // selector: keccak256("setOperator(address,uint48)")[0:4] = 0xd4febb96
      setStep('operator')
      const MAX_UINT48 = 281_474_976_710_655n
      const setOperatorData =
        '0xd4febb96' +
        ADDRESSES.vault.slice(2).toLowerCase().padStart(64, '0') +
        MAX_UINT48.toString(16).padStart(64, '0')
      const operatorTxHash = await sendTx(eth, { from: address, to: ADDRESSES.cusd, data: setOperatorData, gas: '0x186a0' })
      if (operatorTxHash) await waitForReceipt(eth, operatorTxHash)

      // Step 2: client-side encryption via Zama SDK
      setStep('encrypting')
      await initSDK()
      const instance = await createInstance({
        ...SepoliaConfig,
        network: import.meta.env.VITE_SEPOLIA_RPC_URL,
      })
      const encInput = instance.createEncryptedInput(getAddress(ADDRESSES.vault), getAddress(address))
      encInput.add64(rawAmount)
      const { handles, inputProof } = await encInput.encrypt()
      // handles[0] is Uint8Array(32), inputProof is Uint8Array — encode as deposit(bytes32, bytes)
      const handle = handles[0] as Uint8Array

      // Step 3: deposit(bytes32 encryptedAmount, bytes inputProof)
      // selector: keccak256("deposit(bytes32,bytes)")[0:4] = 0xe29973fc
      setStep('depositing')
      const toHex = (u: Uint8Array) => u.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')

      // ABI-encode deposit(bytes32, bytes):
      //   [0x00] selector (4 bytes)
      //   [0x04] handle   (32 bytes, left-padded — but it already is 32 bytes)
      //   [0x24] offset of bytes param = 0x40 (64)
      //   [0x44] length of inputProof
      //   [0x64] inputProof data (padded to 32-byte boundary)
      const proofHex = toHex(inputProof)
      const proofLen = inputProof.length
      const proofPadded = proofHex.padEnd(Math.ceil(proofLen / 32) * 64, '0')
      const depositData =
        '0xe29973fc' +
        toHex(handle) +
        '0000000000000000000000000000000000000000000000000000000000000040' +
        proofLen.toString(16).padStart(64, '0') +
        proofPadded

      const depositTxHash = await sendTx(eth, { from: address, to: ADDRESSES.vault, data: depositData, gas: '0x7a120' })
      if (depositTxHash) await waitForReceipt(eth, depositTxHash)
      else await new Promise(r => setTimeout(r, 4000))

      setStep('done')
      onDeposited()
    } catch (e: any) {
      const msg = e?.message ?? e?.reason ?? e?.info?.error?.message ?? JSON.stringify(e)
      console.error('deposit error:', msg, e)
      setErrorMsg(msg)
      setStep('error')
    }
  }

  return (
    <div
      onClick={onBackdrop}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
        overflow: 'hidden',
      }}
    >
      {/* Fixed-size inner stage — always 1200px wide, immune to MetaMask sidebar shrinking viewport */}
      <div style={{
        position: 'absolute',
        top: 0, bottom: 0,
        left: '50%', transform: 'translateX(-50%)',
        width: 1200, pointerEvents: 'none',
      }}>
      <img
        src="/figurine-pink-holding.png"
        alt=""
        style={{
          position: 'absolute',
          bottom: 0, left: '53%',
          transform: bubbleVisible ? 'translateX(-60%)' : 'translateX(-60%) translateY(60px)',
          height: '95vh', width: 'auto',
          filter: 'drop-shadow(0 -12px 80px rgba(232,130,180,0.5))',
          opacity: bubbleVisible ? 1 : 0,
          transition: `opacity 800ms ${EASE}, transform 800ms cubic-bezier(0.34,1.2,0.64,1)`,
          pointerEvents: 'none',
        }}
      />

      {/* Thought bubble above figurine's head */}
      <div style={{
        position: 'absolute',
        top: '9%', left: '7%',
        width: 240,
        pointerEvents: 'none',
        opacity: bubbleVisible ? 1 : 0,
        transform: bubbleVisible ? 'scale(1)' : 'scale(0.4)',
        transformOrigin: 'bottom center',
        transition: `opacity 700ms ${EASE} 200ms, transform 700ms cubic-bezier(0.34,1.6,0.64,1) 200ms`,
      }}>
        <div style={{
          background: 'linear-gradient(135deg, rgba(25,25,38,0.97) 0%, rgba(18,18,30,0.97) 100%)',
          border: '1.5px solid rgba(255,255,255,0.15)',
          borderRadius: 24,
          padding: '18px 22px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1), 0 0 0 1px rgba(244,132,95,0.1)',
          position: 'relative',
        }}>
          <div style={{ position: 'absolute', top: -1, left: -1, width: 40, height: 40, borderTop: '2px solid #F4845F88', borderLeft: '2px solid #F4845F88', borderRadius: '24px 0 0 0' }} />
          <div style={{ position: 'absolute', bottom: -1, right: -1, width: 30, height: 30, borderBottom: '2px solid #6EB5FF44', borderRight: '2px solid #6EB5FF44', borderRadius: '0 0 24px 0' }} />
          <p style={{ margin: 0, fontSize: '0.8rem', fontWeight: 600, lineHeight: 1.5, letterSpacing: '0.01em', textAlign: 'center', whiteSpace: 'pre-line',
            color: 'white',
          }}>
            {'Deposit your cUSDC here 🔒\nyour principal stays safe\n& fully encrypted. always.'}
          </p>
        </div>
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

      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: '50%', left: '53%',
          transform: 'translate(-59%, -81%)',
          width: 390, borderRadius: 18,
          background: '#13131A', border: `1.5px solid ${vault.bg}44`,
          padding: '1.5rem', zIndex: 10,
          boxShadow: '0 20px 40px -10px rgba(0,0,0,0.6)',
          overflow: 'visible',
          opacity: bubbleVisible ? 1 : 0,
          transition: `opacity 300ms ${EASE}`,
          pointerEvents: 'auto',
        }}
      >
        <button onClick={onClose} style={{
          position: 'absolute', top: 16, right: 16,
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 50, width: 32, height: 32, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.5)',
        }}>
          <X size={15} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12, flexShrink: 0,
            background: `linear-gradient(135deg, ${vault.bg}44, ${vault.bg}88)`,
            border: `1.5px solid ${vault.bg}66`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'Anton', sans-serif", fontSize: '0.75rem', color: vault.bg, letterSpacing: '0.05em',
          }}>
            {vault.token.slice(0, 2)}
          </div>
          <div>
            <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.1rem', color: 'white', letterSpacing: '0.05em' }}>{vault.name}</div>
            <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>
              CONFIDENTIAL VAULT · ZAMA FHE · {vault.drawPeriodLabel}
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
          gap: 1, borderRadius: 12, overflow: 'hidden', marginBottom: '1.5rem',
          border: '1px solid rgba(255,255,255,0.07)',
        }}>
          {[
            { label: 'GRAND PRIZE', value: `${vault.grandPrize} USDC` },
            { label: 'TOTAL DEPOSITED', value: vault.totalDeposits === '—' ? '—' : `$${vault.totalDeposits}` },
            { label: 'DRAW EVERY', value: vault.drawPeriod },
          ].map(item => (
            <div key={item.label} style={{ background: 'rgba(255,255,255,0.04)', padding: '0.75rem 0.85rem' }}>
              <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: vault.bg }}>{item.value}</div>
            </div>
          ))}
        </div>

        {step === 'done' ? (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🎉</div>
            <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.2rem', color: '#6BBF7A', letterSpacing: '0.05em', marginBottom: 6 }}>DEPOSIT SUCCESSFUL</div>
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)', marginBottom: '1.5rem' }}>
              Your balance is now encrypted. You're in the draw!
            </div>
            <button onClick={onClose} style={{
              width: '100%', padding: '0.85rem',
              background: '#6BBF7A', border: 'none', borderRadius: 50,
              color: '#0A0A0F', fontSize: '0.78rem', fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
            }}>
              DONE
            </button>
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
            <div style={{ marginBottom: '1.25rem' }}>
              <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                Amount ({vault.token})
              </div>
              <div style={{
                display: 'flex', alignItems: 'center',
                background: 'rgba(255,255,255,0.05)', border: `1.5px solid ${step === 'input' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 12, overflow: 'hidden',
              }}>
                <input
                  type="number"
                  placeholder="0.00"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  disabled={step !== 'input'}
                  style={{
                    flex: 1, background: 'transparent', border: 'none', outline: 'none',
                    color: 'white', fontSize: '1.1rem', fontWeight: 600,
                    padding: '0.85rem 1rem',
                  }}
                />
                <span style={{ padding: '0 1rem', fontSize: '0.75rem', fontWeight: 700, color: vault.bg, letterSpacing: '0.08em' }}>
                  {vault.token}
                </span>
              </div>
            </div>

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

            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              background: `${vault.bg}11`, border: `1px solid ${vault.bg}33`,
              borderRadius: 10, padding: '0.7rem 0.85rem', marginBottom: '1.5rem',
            }}>
              <Lock size={13} style={{ color: vault.bg, flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: '0.67rem', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
                Your balance is encrypted on-chain using Zama FHE. Only you can decrypt it.
              </span>
            </div>

            {!wallet ? (
              <div style={{ textAlign: 'center', fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', padding: '0.5rem 0' }}>
                Connect your wallet to deposit
              </div>
            ) : step === 'input' ? (
              <button
                onClick={handleDeposit}
                disabled={!amount || Number(amount) <= 0}
                style={{
                  width: '100%', padding: '0.85rem',
                  background: !amount || Number(amount) <= 0 ? 'rgba(255,255,255,0.06)' : vault.bg,
                  border: 'none', borderRadius: 50,
                  color: !amount || Number(amount) <= 0 ? 'rgba(255,255,255,0.3)' : '#0A0A0F',
                  fontSize: '0.78rem', fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  cursor: !amount || Number(amount) <= 0 ? 'not-allowed' : 'pointer',
                  transition: `background 200ms ${EASE}`,
                }}
              >
                DEPOSIT
              </button>
            ) : (
              <div style={{ textAlign: 'center', padding: '0.6rem 0' }}>
                <div style={{ fontSize: '0.75rem', color: vault.bg, fontWeight: 600, letterSpacing: '0.08em' }}>
                  {step === 'operator'    ? '⏳ Authorising vault (setOperator)...' :
                   step === 'encrypting' ? '🔒 Encrypting amount (Zama SDK)...' :
                                           '⏳ Depositing into vault...'}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                  Confirm in MetaMask if prompted
                </div>
              </div>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  )
}

// ── Plain Deposit Modal (non-mUSDC vaults) ────────────────────────────────────
function PlainDepositModal({ vault, wallet, onClose }: { vault: VaultType; wallet: string | null; onClose: () => void }) {
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<'input' | 'approving' | 'depositing' | 'done'>('input')

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleDeposit = async () => {
    if (!amount || Number(amount) <= 0) return
    setStep('approving')
    await new Promise(r => setTimeout(r, 1200))
    setStep('depositing')
    await new Promise(r => setTimeout(r, 1500))
    setStep('done')
  }

  return (
    <div onClick={onBackdrop} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 420, borderRadius: 18,
        background: '#13131A', border: `1.5px solid ${vault.bg}44`,
        padding: '1.5rem', position: 'relative',
        boxShadow: '0 20px 40px -10px rgba(0,0,0,0.6)',
      }}>
        <button onClick={onClose} style={{
          position: 'absolute', top: 16, right: 16,
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 50, width: 32, height: 32, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.5)',
        }}>
          <X size={15} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12, flexShrink: 0,
            background: `linear-gradient(135deg, ${vault.bg}44, ${vault.bg}88)`,
            border: `1.5px solid ${vault.bg}66`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'Anton', sans-serif", fontSize: '0.75rem', color: vault.bg, letterSpacing: '0.05em',
          }}>
            {vault.token.slice(0, 2)}
          </div>
          <div>
            <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.1rem', color: 'white', letterSpacing: '0.05em' }}>{vault.name}</div>
            <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>
              CONFIDENTIAL VAULT · ZAMA FHE · {vault.drawPeriodLabel}
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
          gap: 1, borderRadius: 12, overflow: 'hidden', marginBottom: '1.5rem',
          border: '1px solid rgba(255,255,255,0.07)',
        }}>
          {[
            { label: 'GRAND PRIZE', value: `${vault.grandPrize} USDC` },
            { label: 'TOTAL DEPOSITED', value: vault.totalDeposits === '—' ? '—' : `$${vault.totalDeposits}` },
            { label: 'DRAW EVERY', value: vault.drawPeriod },
          ].map(item => (
            <div key={item.label} style={{ background: 'rgba(255,255,255,0.04)', padding: '0.75rem 0.85rem' }}>
              <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: vault.bg }}>{item.value}</div>
            </div>
          ))}
        </div>

        {step === 'done' ? (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🎉</div>
            <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.2rem', color: '#6BBF7A', letterSpacing: '0.05em', marginBottom: 6 }}>DEPOSIT SUCCESSFUL</div>
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)', marginBottom: '1.5rem' }}>
              Your balance is now encrypted. You're in the draw!
            </div>
            <button onClick={onClose} style={{
              width: '100%', padding: '0.85rem',
              background: '#6BBF7A', border: 'none', borderRadius: 50,
              color: '#0A0A0F', fontSize: '0.78rem', fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
            }}>DONE</button>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: '1.25rem' }}>
              <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                Amount ({vault.token})
              </div>
              <div style={{
                display: 'flex', alignItems: 'center',
                background: 'rgba(255,255,255,0.05)', border: `1.5px solid ${step === 'input' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 12, overflow: 'hidden',
              }}>
                <input
                  type="number" placeholder="0.00" value={amount}
                  onChange={e => setAmount(e.target.value)}
                  disabled={step !== 'input'}
                  style={{
                    flex: 1, background: 'transparent', border: 'none', outline: 'none',
                    color: 'white', fontSize: '1.1rem', fontWeight: 600, padding: '0.85rem 1rem',
                  }}
                />
                <span style={{ padding: '0 1rem', fontSize: '0.75rem', fontWeight: 700, color: vault.bg, letterSpacing: '0.08em' }}>
                  {vault.token}
                </span>
              </div>
            </div>

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

            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              background: `${vault.bg}11`, border: `1px solid ${vault.bg}33`,
              borderRadius: 10, padding: '0.7rem 0.85rem', marginBottom: '1.5rem',
            }}>
              <Lock size={13} style={{ color: vault.bg, flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: '0.67rem', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
                Your balance is encrypted on-chain using Zama FHE. Only you can decrypt it.
              </span>
            </div>

            {!wallet ? (
              <div style={{ textAlign: 'center', fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', padding: '0.5rem 0' }}>
                Connect your wallet to deposit
              </div>
            ) : step === 'input' ? (
              <button onClick={handleDeposit} disabled={!amount || Number(amount) <= 0} style={{
                width: '100%', padding: '0.85rem',
                background: !amount || Number(amount) <= 0 ? 'rgba(255,255,255,0.06)' : vault.bg,
                border: 'none', borderRadius: 50,
                color: !amount || Number(amount) <= 0 ? 'rgba(255,255,255,0.3)' : '#0A0A0F',
                fontSize: '0.78rem', fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
              }}>DEPOSIT</button>
            ) : (
              <div style={{ textAlign: 'center', padding: '0.6rem 0' }}>
                <div style={{ fontSize: '0.75rem', color: vault.bg, fontWeight: 600, letterSpacing: '0.08em' }}>
                  {step === 'approving' ? '⏳ Approving token spend...' : '⏳ Depositing into vault...'}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>Confirm in MetaMask</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function DepositPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(false)
  const [wallet, setWallet] = useState<string | null>(null)
  const [_walletError, setWalletError] = useState<string | null>(null)
  const [selectedVault, setSelectedVault] = useState<VaultType | null>(null)
  const [swapOpen, setSwapOpen] = useState(false)
  const [totalDeposits, setTotalDeposits] = useState<string | null>(null)

  const fetchTotalDeposits = useCallback(async () => {
    try {
      const provider = new BrowserProvider((window as any).ethereum)
      const vault = new Contract(ADDRESSES.vault, VAULT_ABI, provider)
      const raw: bigint = await vault.totalDeposits()
      setTotalDeposits(Number(formatUnits(raw, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 }))
    } catch {
      // RPC unavailable or MetaMask not connected yet — leave as null
    }
  }, [])

  const connectWallet = useCallback(async () => {
    setWalletError(null)
    const eth = (window as any).ethereum
    if (!eth) { setWalletError('MetaMask not found — install it first.'); return }
    try {
      // Try silent read first — avoids -32002 if MetaMask already has permission
      let accounts: string[] = await eth.request({ method: 'eth_accounts' })
      if (!accounts.length) {
        // Retry loop handles -32002 (stuck pending request) by waiting it out
        for (let i = 0; i < 10; i++) {
          try {
            accounts = await eth.request({ method: 'eth_requestAccounts' })
            break
          } catch (e: any) {
            if (e?.code === -32002) {
              await new Promise(r => setTimeout(r, 2000))
            } else {
              throw e
            }
          }
        }
      }
      if (accounts.length) {
        setWallet(accounts[0])
        setWalletError(null)
      }
    } catch (e: any) {
      if (e?.code === 4001) setWalletError('Connection rejected.')
    }
  }, [])

  // Read already-connected account on mount + track changes
  useEffect(() => {
    const eth = (window as any).ethereum
    if (!eth) return
    eth.request({ method: 'eth_accounts' }).then((accounts: string[]) => {
      if (accounts.length > 0) setWallet(accounts[0])
    })
    // Only update on a real account switch — ignore the transient [] MetaMask emits
    // mid-flow when eth_requestAccounts opens its popup (MetaMask bug: "unexpectedly updated accounts")
    const onAccounts = (accounts: string[]) => { if (accounts.length > 0) setWallet(accounts[0]) }
    eth.on('accountsChanged', onAccounts)
    return () => eth.removeListener('accountsChanged', onAccounts)
  }, [])

  useEffect(() => { fetchTotalDeposits() }, [fetchTotalDeposits])


  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 60)
    return () => clearTimeout(t)
  }, [])

  const filtered = VAULTS.filter(v =>
    v.name.toLowerCase().includes(search.toLowerCase()) ||
    v.token.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
    <div style={{
      minHeight: '100vh',
      background: '#0F0F14',
      fontFamily: "'Inter', sans-serif",
      position: 'relative',
      overflowX: 'hidden',
    }}>
      {/* Grain */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 50,
        backgroundImage: GRAIN_SVG, backgroundSize: '200px 200px',
        backgroundRepeat: 'repeat', opacity: 0.4,
      }} aria-hidden="true" />

      {/* Ambient blobs */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', width: 700, height: 700, borderRadius: '50%', background: 'radial-gradient(circle, #6EB5FF14 0%, transparent 65%)', top: -300, left: -200 }} />
        <div style={{ position: 'absolute', width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle, #F4845F10 0%, transparent 65%)', bottom: -100, right: -150 }} />
      </div>

      {/* ── Figurine + bubble — fixed right side ── */}
      <div style={{
        position: 'fixed',
        right: 0, bottom: 0,
        width: '26vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 10,
      }}>
        {/* Figurine — full viewport height, anchored to bottom */}
        <img
          src="/figurine-orange.png"
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            bottom: 0,
            left: '50%',
            transform: visible ? 'translateX(-50%)' : 'translateX(-50%) translateY(60px)',
            height: '70vh',
            width: 'auto',
            maxWidth: 'none',
            filter: 'drop-shadow(0 -12px 60px rgba(244,132,95,0.4))',
            opacity: visible ? 1 : 0,
            transition: `opacity 800ms ${EASE} 600ms, transform 800ms cubic-bezier(0.34,1.2,0.64,1) 600ms`,
          }}
        />

        {/* Thought bubble — top of panel, above the head */}
        <div style={{ position: 'absolute', top: '12%', left: '4px', right: '4px' }}>
          <ThoughtBubble visible={visible} />
        </div>
      </div>

      {/* ── Main content — left-weighted ── */}
      <div style={{
        position: 'relative', zIndex: 1,
        // leave right side free for figurine
        marginRight: '26vw',
        padding: '7rem 3rem 5rem 3rem',
        maxWidth: '100%',
      }}>

      {/* ── Full-width nav bar ── */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '1.5rem 2.5rem',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-10px)',
        transition: `opacity 500ms ${EASE}, transform 500ms ${EASE}`,
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            background: 'rgba(255,255,255,0.06)', border: '1.5px solid rgba(255,255,255,0.14)',
            borderRadius: 50, padding: '0.6rem 1.2rem',
            color: 'white', fontSize: '0.72rem', fontWeight: 700,
            letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
            transition: `background 200ms ${EASE}, border-color 200ms ${EASE}`,
          }}
          onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.12)'; ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.3)' }}
          onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.14)' }}
        >
          <ArrowLeft size={14} /> Back
        </button>

        <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontFamily: "'Anton', sans-serif", fontSize: '1.05rem', letterSpacing: '0.2em', color: 'white', textTransform: 'uppercase' }}>
          VAULTSHOT
        </span>

        {wallet ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => navigate('/profile')} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'rgba(110,181,255,0.08)', border: '1.5px solid rgba(110,181,255,0.3)',
              borderRadius: 50, padding: '0.45rem 1rem',
              color: '#6EB5FF', fontSize: '0.68rem', fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
            }}>MY PORTFOLIO</button>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(107,191,122,0.1)', border: '1.5px solid rgba(107,191,122,0.3)',
              borderRadius: 50, padding: '0.45rem 1rem',
            }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#6BBF7A', boxShadow: '0 0 8px #6BBF7A' }} />
              <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#6BBF7A', letterSpacing: '0.08em', fontFamily: 'monospace' }}>
                {wallet.slice(0, 6)}...{wallet.slice(-4)}
              </span>
            </div>
          </div>
        ) : (
          <button onClick={connectWallet} style={{
            display: 'flex', alignItems: 'center', gap: 7,
            background: 'rgba(244,132,95,0.08)', border: '1.5px solid #F4845F',
            borderRadius: 50, padding: '0.45rem 1rem',
            color: '#F4845F', fontSize: '0.68rem', fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
            transition: `background 200ms ${EASE}, border-color 200ms ${EASE}`,
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(244,132,95,0.18)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(244,132,95,0.08)' }}
          >
            CONNECT TO WALLET
          </button>
        )}
      </div>

        {/* Heading */}
        <div style={{
          marginBottom: '3rem',
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(18px)',
          transition: `opacity 600ms ${EASE} 80ms, transform 600ms ${EASE} 80ms`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: '0.5rem' }}>
            <Star size={11} fill="#F4845F" color="#F4845F" />
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#F4845F', letterSpacing: '0.2em', textTransform: 'uppercase' }}>
              No-Loss Prize Savings
            </span>
          </div>
          <h1 style={{
            fontFamily: "'Anton', sans-serif",
            fontSize: 'clamp(2.2rem, 5vw, 3.8rem)',
            fontWeight: 400, color: 'white',
            lineHeight: 1, letterSpacing: '-0.01em',
            textTransform: 'uppercase', margin: 0,
          }}>
            CHOOSE YOUR <span style={{ color: '#6EB5FF' }}>VAULT</span>
          </h1>
          <p style={{ fontSize: '0.92rem', color: 'rgba(255,255,255,0.45)', marginTop: '0.75rem', maxWidth: 460, lineHeight: 1.65 }}>
            Deposit assets into encrypted vaults. Your principal is always safe.
            Yield flows to the prize pool — and every draw, someone wins it all.
          </p>
        </div>

        {/* Stats */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.85rem',
          marginBottom: '2.5rem',
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(16px)',
          transition: `opacity 600ms ${EASE} 180ms, transform 600ms ${EASE} 180ms`,
        }}>
          {STATS.map((stat, i) => (
            <div key={i} style={{
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 14, padding: '1.2rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: '0.5rem' }}>
                <span style={{ color: stat.color, opacity: 0.85 }}>{stat.icon}</span>
                <span style={{ fontSize: '0.58rem', fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                  {stat.label}
                </span>
              </div>
              <div style={{ fontFamily: "'Anton', sans-serif", fontSize: 'clamp(1.4rem, 2.5vw, 2rem)', color: stat.color, lineHeight: 1 }}>
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* Table header + search */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: '1.1rem',
          opacity: visible ? 1 : 0, transition: `opacity 500ms ${EASE} 260ms`,
        }}>
          <h2 style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.1rem', color: 'white', margin: 0, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            PRIZE VAULTS
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Swap button */}
            <button
              onClick={() => setSwapOpen(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'linear-gradient(135deg, rgba(232,130,180,0.15), rgba(110,181,255,0.1))',
                border: '1.5px solid rgba(232,130,180,0.4)',
                borderRadius: 50, padding: '0.5rem 1.1rem',
                color: '#E882B4', fontSize: '0.72rem', fontWeight: 700,
                letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
                transition: `background 200ms ${EASE}, border-color 200ms ${EASE}`,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'linear-gradient(135deg, rgba(232,130,180,0.28), rgba(110,181,255,0.18))'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(232,130,180,0.7)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'linear-gradient(135deg, rgba(232,130,180,0.15), rgba(110,181,255,0.1))'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(232,130,180,0.4)' }}
            >
              <span style={{ fontSize: '0.85rem' }}>⇄</span> SWAP mUSDC → cUSDC
            </button>

            {/* Search */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 50, padding: '0.5rem 1rem',
            }}>
              <Search size={13} color="rgba(255,255,255,0.35)" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search vaults..."
                style={{ background: 'transparent', border: 'none', outline: 'none', color: 'white', fontSize: '0.78rem', width: 150 }} />
            </div>
          </div>
        </div>

        {/* Column headers */}
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 150px', gap: '1rem',
          padding: '0 1.5rem 0.6rem',
          color: 'rgba(255,255,255,0.28)', fontSize: '0.6rem', fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase',
          opacity: visible ? 1 : 0, transition: `opacity 500ms ${EASE} 300ms`,
        }}>
          <span>Vault</span><span>Grand Prize</span><span>Total Deposited</span><span>Draw Every</span>
          <span style={{ textAlign: 'right' }}>Action</span>
        </div>

        {filtered.map((vault, i) => (
          <VaultRow
            key={vault.id} vault={vault} index={i}
            onDeposit={() => setSelectedVault(vault)}
            totalDepositsOverride={vault.id === 1 ? totalDeposits : undefined}
          />
        ))}

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'rgba(255,255,255,0.25)', fontSize: '0.85rem' }}>
            No vaults match "{search}"
          </div>
        )}

        {/* Footer */}
        <div style={{
          marginTop: '3rem', paddingTop: '1.75rem',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem',
          opacity: visible ? 1 : 0, transition: `opacity 600ms ${EASE} 700ms`,
        }}>
          <p style={{ margin: 0, fontSize: '0.73rem', color: 'rgba(255,255,255,0.28)', lineHeight: 1.6 }}>
            All balances encrypted via <span style={{ color: 'rgba(110,181,255,0.8)', fontWeight: 600 }}>Zama FHEVM</span>. Principal never at risk.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {['#6EB5FF','#F4845F','#6BBF7A','#E882B4'].map(c => (
              <div key={c} style={{ width: 7, height: 7, borderRadius: '50%', background: c }} />
            ))}
            <span style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', textTransform: 'uppercase', marginLeft: 4 }}>VAULTSHOT · Sepolia</span>
          </div>
        </div>

      </div>
    </div>

    {selectedVault && selectedVault.id === 1 && (
      <DepositModal vault={selectedVault} wallet={wallet} onClose={() => setSelectedVault(null)} onDeposited={fetchTotalDeposits} />
    )}
    {selectedVault && selectedVault.id !== 1 && (
      <PlainDepositModal vault={selectedVault} wallet={wallet} onClose={() => setSelectedVault(null)} />
    )}
    {swapOpen && (
      <SwapModal wallet={wallet} onClose={() => setSwapOpen(false)} />
    )}
    </>
  )
}
