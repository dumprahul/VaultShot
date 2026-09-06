import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'

// ── VAULTSHOT content data ─────────────────────────────────────────────────
// Four "vault characters" — each slide represents a stage of the protocol.
// Background colours cycle through the arcade palette from the brief.
const SLIDES = [
  {
    bg: '#F4845F',
    panel: '#F79B7F',
    label: 'DEPOSIT',
    headline: 'Drop It In',
    body: 'Your funds enter the encrypted vault. Principal locked safe forever. Nobody — not even the contract — sees your balance.',
    tag: '01 / DEPOSIT',
    img: '/figurine-blue.png',
  },
  {
    bg: '#E882B4',
    panel: '#ED9DC4',
    label: 'YIELD',
    headline: 'Watch It Grow',
    body: 'Your pooled deposits earn yield through DeFi lending. Every tick the prize swells. Encrypted, live, unstoppable.',
    tag: '02 / YIELD',
    img: '/figurine-orange2.png',
  },
  {
    bg: '#6BBF7A',
    panel: '#85CC92',
    label: 'DRAW',
    headline: 'The Cipher Breaks',
    body: 'Zama FHEVM runs a verifiable random draw over encrypted state. No front-running. No peeking. Pure fairness.',
    tag: '03 / DRAW',
    img: '/figurine-pink.png',
  },
  {
    bg: '#6EB5FF',
    panel: '#8DC4FF',
    label: 'CLAIM',
    headline: 'Vault Opens',
    body: 'The winner claims via EIP-712 signature. Privacy-preserving. You prove you won without revealing what you won.',
    tag: '04 / CLAIM',
    img: '/figurine-green.png',
  },
]

// Grain SVG data URI
const GRAIN_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E")`

const EASE = 'cubic-bezier(0.4,0,0.2,1)'
const DURATION = 650

export default function VaultShot() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Preload images on mount
  useEffect(() => {
    SLIDES.forEach(s => { const img = new Image(); img.src = s.img })
  }, [])

  // Responsive
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const navigate = useCallback((dir: 'next' | 'prev') => {
    if (isAnimating) return
    setIsAnimating(true)
    setActiveIndex(prev => dir === 'next' ? (prev + 1) % 4 : (prev + 3) % 4)
    timerRef.current = setTimeout(() => setIsAnimating(false), DURATION)
  }, [isAnimating])

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') navigate('next')
      if (e.key === 'ArrowLeft')  navigate('prev')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  // Roles
  const center = activeIndex
  const left   = (activeIndex + 3) % 4
  const right  = (activeIndex + 1) % 4
  const _back  = (activeIndex + 2) % 4; void _back

  function getRole(i: number) {
    if (i === center) return 'center'
    if (i === left)   return 'left'
    if (i === right)  return 'right'
    return 'back'
  }

  function getItemStyle(i: number): React.CSSProperties {
    const role = getRole(i)
    const base: React.CSSProperties = {
      position: 'absolute',
      aspectRatio: '0.6 / 1',
      transition: `transform ${DURATION}ms ${EASE}, filter ${DURATION}ms ${EASE}, opacity ${DURATION}ms ${EASE}, left ${DURATION}ms ${EASE}, height ${DURATION}ms ${EASE}, bottom ${DURATION}ms ${EASE}`,
      willChange: 'transform, filter, opacity',
    }
    if (role === 'center') return { ...base,
      transform: `translateX(-50%) scale(${isMobile ? 1.25 : 1.68})`,
      filter: 'none', opacity: 1, zIndex: 20,
      left: '50%',
      height: isMobile ? '60%' : '92%',
      bottom: isMobile ? '22%' : 0,
    }
    if (role === 'left') return { ...base,
      transform: 'translateX(-50%) scale(1)',
      filter: 'blur(2px)', opacity: 0.85, zIndex: 10,
      left: isMobile ? '20%' : '30%',
      height: isMobile ? '16%' : '28%',
      bottom: isMobile ? '32%' : '12%',
    }
    if (role === 'right') return { ...base,
      transform: 'translateX(-50%) scale(1)',
      filter: 'blur(2px)', opacity: 0.85, zIndex: 10,
      left: isMobile ? '80%' : '70%',
      height: isMobile ? '16%' : '28%',
      bottom: isMobile ? '32%' : '12%',
    }
    // back
    return { ...base,
      transform: 'translateX(-50%) scale(1)',
      filter: 'blur(4px)', opacity: 0.6, zIndex: 5,
      left: '50%',
      height: isMobile ? '13%' : '22%',
      bottom: isMobile ? '32%' : '12%',
    }
  }

  const active = SLIDES[activeIndex]

  return (
    <div
      style={{
        backgroundColor: active.bg,
        transition: `background-color ${DURATION}ms ${EASE}`,
        fontFamily: "'Inter', sans-serif",
        position: 'relative',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>

        {/* 1 · Grain overlay */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 50,
          backgroundImage: GRAIN_SVG,
          backgroundSize: '200px 200px',
          backgroundRepeat: 'repeat',
          opacity: 0.4,
        }} aria-hidden="true" />

        {/* 2 · Giant ghost text */}
        <div style={{
          position: 'absolute', insetInline: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', userSelect: 'none',
          zIndex: 2, top: '18%',
        }} aria-hidden="true">
          <span style={{
            fontFamily: "'Anton', sans-serif",
            fontSize: 'clamp(90px, 28vw, 380px)',
            fontWeight: 900,
            color: 'white',
            opacity: 1,
            lineHeight: 1,
            textTransform: 'uppercase',
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
          }}>
            VAULTSHOT
          </span>
        </div>

        {/* 3 · Top-left brand label */}
        <div style={{
          position: 'absolute', top: '1.5rem',
          left: isMobile ? '1rem' : '2rem',
          zIndex: 60,
        }}>
          <span style={{
            fontSize: '0.7rem', fontWeight: 600,
            textTransform: 'uppercase', color: 'white',
            opacity: 0.9, letterSpacing: '0.18em',
          }}>
            VAULTSHOT
          </span>
        </div>

        {/* Top-right: stage indicator */}
        <div style={{
          position: 'absolute', top: '1.5rem',
          right: isMobile ? '1rem' : '2rem',
          zIndex: 60, display: 'flex', gap: '6px',
        }}>
          {SLIDES.map((_, i) => (
            <button
              key={i}
              onClick={() => { if (!isAnimating) { setIsAnimating(true); setActiveIndex(i); setTimeout(() => setIsAnimating(false), DURATION) } }}
              aria-label={`Go to slide ${i + 1}`}
              style={{
                width: i === activeIndex ? 24 : 8,
                height: 8, borderRadius: 4,
                background: 'white',
                opacity: i === activeIndex ? 1 : 0.35,
                border: 'none', cursor: 'pointer', padding: 0,
                transition: `width ${DURATION}ms ${EASE}, opacity ${DURATION}ms ${EASE}`,
              }}
            />
          ))}
        </div>

        {/* 4 · Carousel */}
        <div style={{ position: 'absolute', inset: 0, zIndex: 3 }}>
          {SLIDES.map((slide, i) => (
            <div key={i} style={getItemStyle(i)}>
              <img
                src={slide.img}
                alt={slide.label}
                draggable={false}
                style={{
                  width: '100%', height: '100%',
                  objectFit: 'contain',
                  objectPosition: 'bottom center',
                }}
              />
              {/* stage tag on center card */}
              {getRole(i) === 'center' && (
                <div style={{
                  position: 'absolute', top: 16, left: 16,
                  background: 'rgba(0,0,0,0.45)',
                  backdropFilter: 'blur(8px)',
                  borderRadius: 8, padding: '4px 12px',
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.65rem', fontWeight: 700,
                  color: 'white', letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  pointerEvents: 'none',
                }}>
                  {slide.tag}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 5 · Bottom-left: text + nav buttons */}
        <div style={{
          position: 'absolute',
          bottom: isMobile ? '1.5rem' : '5rem',
          left: isMobile ? '1rem' : '6rem',
          zIndex: 60, maxWidth: 340,
        }}>
          {/* Slide headline */}
          <p style={{
            fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.02em', color: 'white', opacity: 0.95,
            fontSize: isMobile ? '1rem' : '1.375rem',
            marginBottom: isMobile ? '0.5rem' : '0.75rem',
            lineHeight: 1.2,
            transition: `opacity ${DURATION}ms ${EASE}`,
          }}>
            {active.headline}
          </p>

          {/* Body copy — hidden on mobile */}
          {!isMobile && (
            <p style={{
              fontSize: '0.85rem', color: 'white', opacity: 0.82,
              lineHeight: 1.6, marginBottom: '1.25rem', maxWidth: 300,
            }}>
              {active.body}
            </p>
          )}

          {/* Nav arrows */}
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            {(['prev', 'next'] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => navigate(dir)}
                aria-label={dir === 'prev' ? 'Previous' : 'Next'}
                style={{
                  width: isMobile ? 48 : 64, height: isMobile ? 48 : 64,
                  borderRadius: '50%',
                  background: 'transparent',
                  border: '2px solid white',
                  color: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                  transition: `transform 150ms ${EASE}, background-color 150ms ${EASE}`,
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.08)'
                  ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.12)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
                  ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'
                }}
              >
                {dir === 'prev'
                  ? <ArrowLeft size={26} strokeWidth={2.25} />
                  : <ArrowRight size={26} strokeWidth={2.25} />}
              </button>
            ))}
          </div>
        </div>

        {/* 6 · Bottom-right: "TAKE YOUR SHOT" link */}
        <div style={{
          position: 'absolute',
          bottom: isMobile ? '1.5rem' : '5rem',
          right: isMobile ? '1rem' : '2.5rem',
          zIndex: 60,
        }}>
          <Link
            to="/deposit"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              fontFamily: "'Anton', sans-serif",
              fontSize: 'clamp(20px, 4vw, 56px)',
              fontWeight: 400, color: 'white', opacity: 0.95,
              letterSpacing: '-0.02em', lineHeight: 1,
              textTransform: 'uppercase', textDecoration: 'none',
              transition: `opacity 200ms ${EASE}`,
            }}
            onMouseEnter={e => (e.currentTarget as HTMLAnchorElement).style.opacity = '1'}
            onMouseLeave={e => (e.currentTarget as HTMLAnchorElement).style.opacity = '0.95'}
          >
            TAKE YOUR SHOT
            <ArrowRight
              style={{ width: isMobile ? 20 : 32, height: isMobile ? 20 : 32 }}
              strokeWidth={2.25}
            />
          </Link>
        </div>

      </div>
    </div>
  )
}
