import { useState, useEffect } from 'react'
import { X } from 'lucide-react'

const EASE   = 'cubic-bezier(0.4,0,0.2,1)'
const GOLD   = '#FFD700'
const SERVER = import.meta.env.VITE_DRAW_SERVER_URL ?? 'http://localhost:3001'

type DrawStatus = {
  isDrawDue: boolean
  drawCount: number
  nextDrawTime: number
  secondsLeft: number
  stage: number // 0=Idle, 1=TotalRequested (awaiting finalizeDraw)
}

type DrawResult = {
  success: boolean
  drawId: number
  totalDeposits: string
  requestDrawHash: string
  finalizeDrawHash: string
}

type Step = 'idle' | 'checking' | 'running' | 'done' | 'error'

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

export function DrawModal({ onClose }: { onClose: () => void }) {
  const [step, setStep]         = useState<Step>('checking')
  const [status, setStatus]     = useState<DrawStatus | null>(null)
  const [result, setResult]     = useState<DrawResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(0)

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Fetch draw status on mount
  useEffect(() => {
    fetch(`${SERVER}/api/draw/status`)
      .then(r => r.json())
      .then((s: DrawStatus) => {
        setStatus(s)
        setCountdown(s.secondsLeft)
        setStep('idle')
      })
      .catch(() => {
        setErrorMsg('Cannot reach draw server — run: node draw-server.mjs')
        setStep('error')
      })
  }, [])

  // Live countdown
  useEffect(() => {
    if (countdown <= 0) return
    const t = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(t)
  }, [countdown])

  const handleDraw = async () => {
    setStep('running')
    setErrorMsg(null)
    try {
      const res = await fetch(`${SERVER}/api/draw`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setResult(json as DrawResult)
      setStep('done')
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e))
      setStep('error')
    }
  }

  const isDue = countdown === 0
  const isResume = status?.stage === 1 // stuck in TotalRequested — skip requestDraw, go straight to finalizeDraw

  return (
    <div
      onClick={onBackdrop}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 440, borderRadius: 20,
          background: '#13131A', border: `1.5px solid ${GOLD}44`,
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
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.2rem', color: 'white', letterSpacing: '0.06em', marginBottom: 4 }}>
            🎲 TRIGGER DRAW
          </div>
          <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Two-phase FHE draw · Zama publicDecrypt · Admin keypair
          </div>
        </div>

        {step === 'checking' && (
          <div style={{ textAlign: 'center', padding: '2rem 0', color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem' }}>
            Checking draw server...
          </div>
        )}

        {step === 'done' && result && (
          <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🏆</div>
            <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.2rem', color: '#6BBF7A', letterSpacing: '0.05em', marginBottom: '1rem' }}>
              DRAW #{result.drawId} COMPLETE
            </div>
            <div style={{
              background: 'rgba(107,191,122,0.06)', border: '1px solid rgba(107,191,122,0.2)',
              borderRadius: 10, padding: '0.85rem 1rem', marginBottom: '1.25rem', textAlign: 'left',
            }}>
              <Row label="Draw ID"        value={`#${result.drawId}`} />
              <Row label="Total pool"     value={`${result.totalDeposits} cUSD`} />
              <Row label="requestDraw tx" value={`${result.requestDrawHash.slice(0,10)}...`} link={`https://sepolia.etherscan.io/tx/${result.requestDrawHash}`} />
              <Row label="finalizeDraw tx" value={`${result.finalizeDrawHash.slice(0,10)}...`} link={`https://sepolia.etherscan.io/tx/${result.finalizeDrawHash}`} last />
            </div>
            <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', marginBottom: '1.25rem' }}>
              Winners have been credited in ciphertext — they can use "Crack the Vault" to reveal their new balance.
            </div>
            <button onClick={onClose} style={{
              width: '100%', padding: '0.85rem',
              background: '#6BBF7A', border: 'none', borderRadius: 50,
              color: '#0A0A0F', fontSize: '0.78rem', fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
            }}>DONE</button>
          </div>
        )}

        {step === 'error' && (
          <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>⚠️</div>
            <div style={{
              fontSize: '0.7rem', color: '#F4845F',
              background: 'rgba(244,132,95,0.08)', border: '1px solid rgba(244,132,95,0.25)',
              borderRadius: 8, padding: '0.75rem', marginBottom: '1.25rem',
              wordBreak: 'break-word', textAlign: 'left', lineHeight: 1.5,
            }}>{errorMsg}</div>
            {errorMsg?.includes('draw-server') && (
              <div style={{
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8, padding: '0.65rem 0.85rem', marginBottom: '1.25rem',
                fontFamily: 'monospace', fontSize: '0.68rem', color: 'rgba(255,255,255,0.5)',
                textAlign: 'left',
              }}>
                $ node draw-server.mjs
              </div>
            )}
            <button onClick={() => { setStep('checking'); setErrorMsg(null); window.location.reload() }} style={{
              width: '100%', padding: '0.85rem',
              background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 50, color: 'white', fontSize: '0.78rem', fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
            }}>RETRY</button>
          </div>
        )}

        {(step === 'idle' || step === 'running') && status && (
          <>
            {/* Status grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: '1.25rem' }}>
              <InfoBox label="Draw #" value={String(status.drawCount + 1)} color={GOLD} />
              <InfoBox
                label={isResume ? 'Status' : isDue ? 'Status' : 'Next draw in'}
                value={isResume ? 'RESUME' : isDue ? 'READY' : fmt(countdown)}
                color={isResume ? '#6EB5FF' : isDue ? '#6BBF7A' : 'rgba(255,255,255,0.5)'}
              />
            </div>

            {/* Draw info */}
            <div style={{
              background: `${GOLD}08`, border: `1px solid ${GOLD}22`,
              borderRadius: 10, padding: '0.75rem 0.9rem', marginBottom: '1.25rem',
              fontSize: '0.65rem', color: 'rgba(255,255,255,0.45)', lineHeight: 1.7,
            }}>
              <strong style={{ color: 'rgba(255,255,255,0.7)' }}>What happens:</strong><br />
              1. <code style={{ color: GOLD }}>requestDraw()</code> — marks encrypted total for public decrypt<br />
              2. Zama <code style={{ color: GOLD }}>publicDecrypt</code> — reveals aggregate total only<br />
              3. <code style={{ color: GOLD }}>finalizeDraw()</code> — weighted lottery, winners credited in FHE
            </div>

            {step === 'running' ? (
              <div style={{ textAlign: 'center', padding: '0.75rem 0' }}>
                <div style={{ fontSize: '0.78rem', color: GOLD, fontWeight: 600, letterSpacing: '0.06em', marginBottom: 4 }}>
                  🎲 Running draw...
                </div>
                <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)' }}>
                  Two on-chain txs + FHE publicDecrypt — takes ~30s
                </div>
              </div>
            ) : isResume ? (
              <button
                onClick={handleDraw}
                style={{
                  width: '100%', padding: '0.9rem',
                  background: `linear-gradient(135deg, #6EB5FF, #4C9EE8)`,
                  border: 'none', borderRadius: 50,
                  color: '#0A0A0F', fontSize: '0.8rem', fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
                  transition: `opacity 200ms ${EASE}`,
                }}
              >
                🔄 RESUME DRAW (finalize)
              </button>
            ) : isDue ? (
              <button
                onClick={handleDraw}
                style={{
                  width: '100%', padding: '0.9rem',
                  background: `linear-gradient(135deg, ${GOLD}, #FFA500)`,
                  border: 'none', borderRadius: 50,
                  color: '#0A0A0F', fontSize: '0.8rem', fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
                  transition: `opacity 200ms ${EASE}`,
                }}
              >
                🎲 TRIGGER DRAW NOW
              </button>
            ) : (
              <div style={{
                width: '100%', padding: '0.9rem', boxSizing: 'border-box',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 50, textAlign: 'center',
                color: 'rgba(255,255,255,0.3)', fontSize: '0.78rem', fontWeight: 700,
                letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>
                ⏳ Draw available in {fmt(countdown)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function InfoBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
      borderRadius: 12, padding: '0.75rem 0.9rem',
    }}>
      <div style={{ fontSize: '0.56rem', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "'Anton', sans-serif", fontSize: '1.1rem', color, letterSpacing: '0.04em' }}>{value}</div>
    </div>
  )
}

function Row({ label, value, link, last }: { label: string; value: string; link?: string; last?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      paddingBottom: last ? 0 : '0.4rem', marginBottom: last ? 0 : '0.4rem',
      borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.06)',
    }}>
      <span style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" style={{ fontSize: '0.65rem', color: '#6BBF7A', fontFamily: 'monospace', textDecoration: 'none' }}>{value} ↗</a>
      ) : (
        <span style={{ fontSize: '0.65rem', color: 'white', fontFamily: 'monospace' }}>{value}</span>
      )}
    </div>
  )
}
