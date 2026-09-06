/**
 * draw-server.mjs — local keeper backend for the VaultShot demo
 *
 * Run once before the demo:   node draw-server.mjs
 * Stays alive on port 3001.
 *
 * POST /api/draw  → runs requestDraw + publicDecrypt + finalizeDraw
 * GET  /api/draw/status → returns { isDrawDue, drawCount, nextDrawTime, secondsLeft }
 *
 * Requires .env in the same directory as this file (ZamaMotion root).
 */

import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Wallet, JsonRpcProvider } from 'ethers'
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node'

// ── load .env manually if present (skipped on Render/cloud where env vars are injected) ──
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '.env')
if (existsSync(envPath)) {
  const envLines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of envLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}

const RPC_URL        = process.env.VITE_SEPOLIA_RPC_URL
const ADMIN_KEY      = process.env.ADMIN_PRIVATE_KEY
const PRIZEPOOL_ADDR = process.env.VITE_PRIZEPOOL_ADDRESS
const PORT           = 3001

if (!RPC_URL || !ADMIN_KEY || !PRIZEPOOL_ADDR) {
  console.error('Missing env vars — check .env for VITE_SEPOLIA_RPC_URL, ADMIN_PRIVATE_KEY, VITE_PRIZEPOOL_ADDRESS')
  process.exit(1)
}

// ── ethers setup ─────────────────────────────────────────────────────────────
const provider = new JsonRpcProvider(RPC_URL)
const admin    = new Wallet(ADMIN_KEY, provider)

// Minimal ABI — only what we need
const PRIZEPOOL_ABI = [
  'function requestDraw() returns (bytes32)',
  'function finalizeDraw(bytes abiEncodedTotal, bytes decryptionProof)',
  'function isDrawDue() view returns (bool)',
  'function drawCount() view returns (uint256)',
  'function nextDrawTime() view returns (uint256)',
  'function stage() view returns (uint8)',
]

const VAULT_ABI = [
  'function pendingTotalHandle() view returns (bytes32)',
]

const VAULT_ADDR = process.env.VITE_VAULT_ADDRESS

// keccak256("DrawRequested(uint256,bytes32)") = 0xaf8a141c...
const DRAW_REQUESTED_TOPIC = '0xaf8a141c850a91b57c69e863d6345ccff7e1351e4e6af6288609484f40d3112a'

function parseDrawRequestedEvent(receipt) {
  for (const log of receipt.logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() === DRAW_REQUESTED_TOPIC.toLowerCase()) {
      // totalHandle is non-indexed — it's in log.data (first 32 bytes)
      return log.data.slice(0, 66) // '0x' + 64 hex chars = bytes32
    }
  }
  return null
}

// ── draw logic ────────────────────────────────────────────────────────────────
async function runDraw() {
  const instance = await createInstance({ ...SepoliaConfig, network: RPC_URL })

  const { Contract, ZeroHash } = await import('ethers')
  const prizePool = new Contract(PRIZEPOOL_ADDR, PRIZEPOOL_ABI, admin)
  const vault     = new Contract(VAULT_ADDR, VAULT_ABI, provider)

  // Check if we're already in TotalRequested (stuck from a previous requestDraw)
  const currentStage = Number(await prizePool.stage())
  // 0 = Idle, 1 = TotalRequested
  let totalHandle
  let requestDrawHash = null

  if (currentStage === 1) {
    // Already requested — grab the pending handle from Vault and skip to publicDecrypt
    console.log('[draw] stage=TotalRequested — skipping requestDraw, resuming publicDecrypt')
    totalHandle = await vault.pendingTotalHandle()
    if (!totalHandle || totalHandle === ZeroHash) throw new Error('pendingTotalHandle is zero — contract in unexpected state')
    console.log('[draw] resuming with existing totalHandle:', totalHandle)
  } else {
    // Phase 1: requestDraw
    console.log('[draw] sending requestDraw()...')
    const tx1 = await prizePool.requestDraw()
    const receipt1 = await tx1.wait()
    requestDrawHash = receipt1.hash
    console.log('[draw] requestDraw mined:', requestDrawHash)

    totalHandle = parseDrawRequestedEvent(receipt1)
    if (!totalHandle) throw new Error('DrawRequested event not found in receipt — check topic hash')
    console.log('[draw] totalHandle:', totalHandle)
  }

  // Off-chain: publicDecrypt
  console.log('[draw] running publicDecrypt...')
  const { clearValues, abiEncodedClearValues, decryptionProof } =
    await instance.publicDecrypt([totalHandle])
  const totalDeposits = BigInt(clearValues[totalHandle] ?? 0n)
  console.log('[draw] total deposits (aggregate):', (Number(totalDeposits) / 1e6).toFixed(2), 'cUSD')

  // Phase 2: finalizeDraw — pass SDK output verbatim
  console.log('[draw] sending finalizeDraw()...')
  const tx2 = await prizePool.finalizeDraw(abiEncodedClearValues, decryptionProof)
  const receipt2 = await tx2.wait()
  console.log('[draw] finalizeDraw mined:', receipt2.hash)

  const drawCount = Number(await prizePool.drawCount())
  return {
    success: true,
    drawId: drawCount,
    totalDeposits: (Number(totalDeposits) / 1e6).toFixed(2),
    requestDrawHash,
    finalizeDrawHash: receipt2.hash,
  }
}

async function getStatus() {
  const { Contract } = await import('ethers')
  const prizePool = new Contract(PRIZEPOOL_ADDR, PRIZEPOOL_ABI, provider)
  const [isDrawDue, drawCount, nextDrawTime, stage] = await Promise.all([
    prizePool.isDrawDue(),
    prizePool.drawCount(),
    prizePool.nextDrawTime(),
    prizePool.stage(),
  ])
  const nowSec = Math.floor(Date.now() / 1000)
  const secondsLeft = Math.max(0, Number(nextDrawTime) - nowSec)
  return {
    isDrawDue: Boolean(isDrawDue),
    drawCount: Number(drawCount),
    nextDrawTime: Number(nextDrawTime),
    secondsLeft,
    stage: Number(stage), // 0=Idle, 1=TotalRequested (awaiting finalizeDraw)
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
let drawInProgress = false

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    if (req.method === 'GET' && req.url === '/api/draw/status') {
      const status = await getStatus()
      res.writeHead(200)
      res.end(JSON.stringify(status))
      return
    }

    if (req.method === 'POST' && req.url === '/api/draw') {
      if (drawInProgress) {
        res.writeHead(409)
        res.end(JSON.stringify({ error: 'Draw already in progress' }))
        return
      }

      // Quick pre-check: is draw due OR is a request already pending (stage=1)?
      const status = await getStatus()
      if (!status.isDrawDue && status.stage !== 1) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: `Draw not due yet — ${status.secondsLeft}s remaining`, secondsLeft: status.secondsLeft }))
        return
      }

      drawInProgress = true
      try {
        const result = await runDraw()
        res.writeHead(200)
        res.end(JSON.stringify(result))
      } finally {
        drawInProgress = false
      }
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
  } catch (e) {
    drawInProgress = false
    console.error('[draw-server] error:', e?.message ?? e)
    res.writeHead(500)
    res.end(JSON.stringify({ error: e?.message ?? String(e) }))
  }
})

server.listen(PORT, () => {
  console.log(`\n🎲 VaultShot draw server running on http://localhost:${PORT}`)
  console.log(`   Admin: ${admin.address}`)
  console.log(`   PrizePool: ${PRIZEPOOL_ADDR}`)
  console.log(`   POST /api/draw        → trigger a draw`)
  console.log(`   GET  /api/draw/status → check if draw is due\n`)
})
