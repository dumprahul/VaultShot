# VaultShot

![VaultShot](screenshots/Screenshot%202026-09-06%20at%201.19.28%E2%80%AFPM.png)

**Confidential no-loss prize savings, built on Zama's Protocol.**
Deposit, earn a shot at the prize, withdraw anytime — and no one but you can see your balance.

📊 **Pitch decks:**
[`vaultshot-contracts(v2)/docs/VaultShot-Pitch-Deck.pdf`](vaultshot-contracts(v2)/docs/VaultShot-Pitch-Deck.pdf) (V2, current architecture) ·
[`vaultshot-mainnet(v3)/VaultShot-Mainnet-Integration.pdf`](vaultshot-mainnet(v3)/VaultShot-Mainnet-Integration.pdf) (V3, the mainnet integration plan)

VaultShot is the confidential-native successor to [FoggyPot (V1)](foggypot(v1)) — instead of
wrapping a plaintext ERC-20 at the vault boundary, it deposits, holds, and pays out an
already-confidential ERC-7984 token (`cUSD`) the whole way through. Deposit amounts, balances, and
withdrawal amounts are real ciphertexts on-chain from the moment they enter the pool. Draws are
provably fair and deposit-weighted using native FHE randomness over encrypted balances; only the
draw's aggregate total is ever revealed in plaintext, never an individual balance; principal (plus
any winnings) is withdrawable at any time, in a single transaction.

## Repo layout

| Path | What it is |
|---|---|
| [`foggypot(v1)/`](foggypot(v1)) | V1 — the original FoggyPot contracts (plaintext-boundary deposits, two-step withdraw) |
| [`vaultshot-contracts(v2)/`](vaultshot-contracts(v2)) | V2 — VaultShot's confidential-native contracts, tests, deploy script, and TS client (documented below) |
| [`vaultshot-app/`](vaultshot-app) | The live frontend (React/Vite) — deposit/withdraw/draw/swap UI, plus `draw-server.mjs`, the keeper script backing the deployed draw bot |
| [`vaultshot-mainnet(v3)/`](vaultshot-mainnet(v3)) | V3 — the mainnet integration pitch deck |
| [`screenshots/`](screenshots) | Pitch deck slide screenshots used in this README |

---

# Part 1 — Technical Reference (V2)

Everything below describes [`vaultshot-contracts(v2)/`](vaultshot-contracts(v2)) — VaultShot's
current, deployed-and-tested architecture.

## Deployed contracts (Sepolia)

| Contract | Address |
|---|---|
| MockUSDC (plaintext test token) | `0x0A284F0eEe6df90f0e24890ba8D5518656705547` |
| VaultShotToken — cUSD (confidential ERC-7984 wrapper) | `0xec33A67568e0529A88d180569E7116cFa37941B5` |
| VaultShotBalanceLedger | `0xf0a4F8FCBb57655f36b82b89eBc8932880efA53B` |
| VaultShotVault | `0x2d2641d32cbA8653EF5b096bcE1f1a1eDe19D0dc` |
| VaultShotReserve | `0xffe467520B520293222FF636Cc4D87Ab8e9d486A` |
| VaultShotPrizePool | `0x3B7008788dcF67184330C91585187840774e19C3` |
| VaultShotDrawKeeper | `0x43bB43D3aBc408A63888cFE228e976F41955fE28` |

One demo pool, 5-minute draw period, 100 cUSD prize budget per draw.

## Draw bot (deployed, live)

**[fhevm-foundry-template.onrender.com](https://fhevm-foundry-template.onrender.com)**

A hosted keeper service — [`vaultshot-app/draw-server.mjs`](vaultshot-app/draw-server.mjs) — that
drives the two-phase draw automatically: `requestDraw()`, the off-chain `publicDecrypt()` round
trip, then `finalizeDraw()`, every time the pool's draw window elapses, so draws keep completing
without anyone manually running a script. See
[Draw automation ("the bot")](#draw-automation-the-bot) below for what it's actually calling under
the hood.

## Getting the test token

`MockUSDC` has a public faucet, 1,000 mUSDC per call, 1-hour cooldown per address:

```solidity
MockUSDC(0x0A284F0eEe6df90f0e24890ba8D5518656705547).faucet()
```

## Full cycle: wrap → deposit → draw → withdraw → unwrap

| Stage | Caller | Function(s) | What happens |
|---|---|---|---|
| Wrap | User | `MockUSDC.approve(cUSD, amount)` then `VaultShotToken.wrap(to, amount)` | Plaintext USDC in, confidential cUSD out. Anyone can wrap for any reason — this boundary is shared/generic, not VaultShot-specific, so wrapping doesn't itself signal an intent to deposit |
| Approve Vault as operator | User | `VaultShotToken.setOperator(vaultAddress, until)` | Time-bound delegation (ERC-7984's equivalent of ERC-20 `approve`) — required once before `Vault.deposit()` can pull your cUSD |
| Deposit | User | `Vault.deposit(externalEuint64 encryptedAmount, bytes inputProof)` | **Encrypt the amount client-side first** (see §2 below) — a genuine confidential transfer into the Vault, no plaintext amount anywhere in this call |
| Check balance | Anyone (read), decrypt: owner only | `Ledger.confidentialBalanceOf` / `seeConfidentialBalance` / `getEncryptedBalance` / `balanceOfEncrypted` (all aliases) | Returns a ciphertext handle for any address — decrypt your own via `userDecrypt` (§3) |
| Draw phase 1 | Admin or keeper | `PrizePool.requestDraw()` | Flags the encrypted running total as publicly decryptable, advances the schedule |
| Draw phase 2 (off-chain) | Anyone's client | `instance.publicDecrypt([totalHandle])` | Reveals the **aggregate total only** — never any individual balance — plus a KMS proof |
| Draw phase 2 (on-chain) | Admin or keeper | `PrizePool.finalizeDraw(abiEncodedTotal, decryptionProof)` | Verifies the proof, pulls the prize budget from Reserve, runs the weighted lottery, credits winners — all in ciphertext |
| Withdraw | User | `Vault.withdraw()` | **Single transaction**, no waiting, no request/finalize split — sends your full balance (principal + any winnings) back as cUSD |
| Unwrap (optional, separate) | User | `VaultShotToken.unwrap(from, to, amount)` then `finalizeUnwrap(...)` | Converts cUSD back to plaintext MockUSDC — a two-step public-decrypt round trip, entirely independent of VaultShot's own contracts |

A full working reference implementation of every step is in
[`vaultshot-contracts(v2)/client/src/vaultshot.ts`](vaultshot-contracts(v2)/client/src/vaultshot.ts):

```bash
cd vaultshot-contracts(v2)/client
npm install
cp .env.example .env   # fill in your keys + the addresses above
npm start
```

## Architecture

| Contract | Responsibility |
|---|---|
| `VaultShotToken` (cUSD) | Confidential ERC-7984 wrapper around MockUSDC, built entirely on OpenZeppelin's audited `ERC7984ERC20Wrapper`. `wrap()`/`unwrap()`/`finalizeUnwrap()` are inherited, unmodified. Shared and generic — not specific to VaultShot |
| `VaultShotVault` | Deposit/withdraw entry point. Both directions are genuine confidential transfers of cUSD — no plaintext amount ever passes through this contract. Owns the encrypted running `totalDeposits` and the single-transaction `withdraw()` |
| `VaultShotBalanceLedger` | Encrypted per-user pool share (`mapping(address => euint64)`), with four differently-named but identical balance-reader aliases plus a batch reader — see §3 |
| `VaultShotReserve` | Holds this pool's admin-funded mock yield, entirely in confidential cUSD (no separate encrypted mirror needed — the token itself is the real holding). Tracks a plaintext `availableBudget` counter fed only by the admin's own funding/payout actions, used to gate the draw's underfunded check |
| `VaultShotPrizePool` | Owns the two-phase draw lifecycle (`requestDraw()` / `finalizeDraw()`). Runs the same weighted running-sum selection loop as FoggyPot, bounded by the just-revealed aggregate total |
| `VaultShotDrawKeeper` | Chainlink Automation entry point ("bot" hook). `checkUpkeep`/`performUpkeep` can only ever trigger phase 1 (`requestDraw`) — there's no way for that interface to wait on the off-chain `publicDecrypt` round trip needed before phase 2, so `finalizeDraw` is driven directly by client/keeper code instead |
| `MockUSDC` | Plaintext test ERC-20 with a public faucet — the one asset that ever crosses the wrap boundary |

### Draw automation ("the bot")

`VaultShotDrawKeeper` implements Chainlink's `checkUpkeep`/`performUpkeep` interface and can be
registered as a standard Chainlink Automation upkeep for phase 1 (`requestDraw`) liveness. Because
phase 2 (`finalizeDraw`) needs an off-chain `publicDecrypt` round trip in between, no on-chain
automation interface can drive it end to end —
[`vaultshot-contracts(v2)/client/src/vaultshot.ts`](vaultshot-contracts(v2)/client/src/vaultshot.ts)
is the reference implementation of the script/bot that drives both phases directly: it calls
`requestDraw()`, fetches the decrypted aggregate total via the Zama Relayer SDK, then calls
`finalizeDraw()` with the resulting proof. [`vaultshot-app/draw-server.mjs`](vaultshot-app/draw-server.mjs)
is what's actually deployed and running this on a schedule at the Render URL above.

---

## Frontend integration guide

Everything below is exactly what
[`vaultshot-contracts(v2)/client/src/vaultshot.ts`](vaultshot-contracts(v2)/client/src/vaultshot.ts)
does — this section documents it standalone so you can wire up your own frontend without reading
the contracts first.

### 1. Setup

```bash
npm install @zama-fhe/relayer-sdk ethers
```

```ts
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node"; // or /web in a browser
import { JsonRpcProvider, Wallet, Contract } from "ethers";

const provider = new JsonRpcProvider(SEPOLIA_RPC_URL);
const instance = await createInstance({ ...SepoliaConfig, network: SEPOLIA_RPC_URL });
```

**Network-mismatch guard** — check this before anything else; VaultShot only exists on Sepolia:

```ts
const network = await provider.getNetwork();
if (network.chainId !== 11155111n) throw new Error("Wrong network — connect to Sepolia.");
```

### 2. Encrypting an amount (`createEncryptedInput`) — required, unlike FoggyPot

Unlike FoggyPot (where `deposit(uint64 amount)` took a plaintext argument), **every VaultShot
function that moves value takes an `externalEuint64` + input proof you build client-side.** This
is the actual "encrypt with the SDK" step:

```ts
async function encryptAmount(contractAddress: string, userAddress: string, amount: bigint) {
  const buffer = instance.createEncryptedInput(contractAddress, userAddress);
  buffer.add64(amount);
  const ciphertext = await buffer.encrypt();
  return { handle: ciphertext.handles[0], proof: ciphertext.inputProof };
}

// Depositing 100 cUSD:
const { handle, proof } = await encryptAmount(VAULT_ADDRESS, userAddress, 100n * 10n ** 6n);
await vault.connect(userSigner).deposit(handle, proof);
```

**The `contractAddress` you pass to `createEncryptedInput` must be the exact contract whose
function will call `FHE.fromExternal` on it** — `VAULT_ADDRESS` for `Vault.deposit()`,
`RESERVE_ADDRESS` for `Reserve.fund()`. Binding the ciphertext to the wrong contract address makes
the proof fail verification on-chain.

### 3. Decrypting a balance (EIP-712 `userDecrypt`) — and the helper aliases

The Ledger exposes the **same encrypted balance handle** through four differently-named functions
plus a batch reader — pick whichever reads best in your UI code, they're interchangeable:

| Function | Signature | Notes |
|---|---|---|
| `confidentialBalanceOf` | `(address account) view returns (bytes32)` | The "canonical" ERC-7984-style name |
| `seeConfidentialBalance` | `(address account) view returns (bytes32)` | Alias — identical handle |
| `getEncryptedBalance` | `(address account) view returns (bytes32)` | Alias — identical handle |
| `balanceOfEncrypted` | `(address account) view returns (bytes32)` | Alias — identical handle |
| `getEncryptedBalances` | `(address[] accounts) view returns (bytes32[])` | Batch reader — fetch several accounts in one call |

Pass a wallet address to any of these, get back a ciphertext handle, then decrypt it:

```ts
async function decryptEuint64(handle: string, contractAddress: string, signer: Signer) {
  if (handle === ethers.ZeroHash) return 0n; // never touched — decrypting would fail

  const address = await signer.getAddress();
  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;
  const extraData = await instance.getExtraData();

  const eip712 = instance.createEIP712(keypair.publicKey, [contractAddress], startTimestamp, durationDays, extraData);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    eip712.message,
  );

  const result = await instance.userDecrypt(
    [{ handle, contractAddress }],
    keypair.privateKey, keypair.publicKey,
    signature.replace("0x", ""),
    [contractAddress], address, startTimestamp, durationDays, extraData,
  );
  return BigInt(result[handle as `0x${string}`]);
}

// A user checking their own pool share — pass their address, get a ciphertext, decrypt it:
const ledger = new Contract(LEDGER_ADDRESS, ["function seeConfidentialBalance(address) view returns (bytes32)"], provider);
const handle = await ledger.seeConfidentialBalance(userAddress);
const balance = await decryptEuint64(handle, LEDGER_ADDRESS, userSigner);
```

**This only works for the account that's actually allowed to see that handle.** ACL permission is
per-account — Bob signing a request for Alice's handle reverts with `UserNotAuthorizedForDecrypt`,
even with a perfectly valid signature. The same `decryptEuint64` helper also decrypts a user's
`cUSD` balance directly off the token (`CUSD_ADDRESS` as `contractAddress` instead of
`LEDGER_ADDRESS`) — useful for showing wallet balance alongside pool balance.

### 4. Functions to call, end to end

| # | Function | Who calls it | Args | Notes |
|---|---|---|---|---|
| 1 | `MockUSDC.faucet()` | Any user | — | 1,000 mUSDC, 1hr cooldown per address |
| 2 | `MockUSDC.approve(cUSD, amount)` | User | `spender, amount` | Standard ERC-20 approval before wrapping |
| 3 | `VaultShotToken.wrap(to, amount)` | User | `address to, uint256 amount` | Plaintext amount — no encryption needed for wrap |
| 4 | `VaultShotToken.setOperator(vault, until)` | User | `address operator, uint48 until` | Required once before depositing — `until = type(uint48).max` for effectively-permanent |
| 5 | `Vault.deposit(encryptedAmount, inputProof)` | User | `externalEuint64, bytes` | **Requires client-side encryption — see §2** |
| 6 | `Ledger.seeConfidentialBalance(address)` (or any alias) | Anyone (read) | `address` | Returns a ciphertext handle — decrypt with §3 |
| 7 | `PrizePool.isDrawDue()` | Anyone (read) | — | `true` once the draw window has elapsed |
| 8 | `PrizePool.requestDraw()` | **Admin or registered keeper only** | — | Phase 1: reverts `"PrizePool: not admin or keeper"` otherwise, or `"PrizePool: too early"` before the window elapses |
| 9 | *(off-chain)* `instance.publicDecrypt([totalHandle])` | Anyone's client | — | Phase 2 setup — see §5 |
| 10 | `PrizePool.finalizeDraw(abiEncodedTotal, decryptionProof)` | Admin or registered keeper | *pass through verbatim from step 9* | Phase 2: reverts `"PrizePool: no draw pending"` if phase 1 hasn't run |
| 11 | `Vault.withdraw()` | User | — | Single transaction — no request/finalize split. Reverts on a never-deposited account (uninitialized ciphertext, nothing to transfer) |
| 12 | `VaultShotToken.unwrap(from, to, encryptedAmount, inputProof)` then `finalizeUnwrap(requestId, cleartext, proof)` | User | — | Optional, separate from VaultShot's own contracts — converts cUSD back to plaintext MockUSDC |

### 5. The two-phase draw (`publicDecrypt`, then `finalizeDraw`)

Bounding the draw's random number needs a **plaintext** divisor (fhEVM has no encrypted-divisor
modulus), so the encrypted running total is revealed once per draw — in aggregate only, never any
individual balance:

```ts
let tx = await prizePool.connect(adminOrKeeperSigner).requestDraw();
const receipt = await tx.wait();

// Parse the DrawRequested event for the handle:
const event = receipt.logs
  .map((log) => { try { return prizePool.interface.parseLog(log); } catch { return null; } })
  .find((parsed) => parsed?.name === "DrawRequested");
const totalHandle = event.args.totalHandle;

const { abiEncodedClearValues, decryptionProof, clearValues } = await instance.publicDecrypt([totalHandle]);
console.log("Total deposits (aggregate only):", clearValues[totalHandle]);

tx = await prizePool.connect(adminOrKeeperSigner).finalizeDraw(abiEncodedClearValues, decryptionProof);
await tx.wait();
```

**Pass `abiEncodedClearValues` and `decryptionProof` through exactly as the SDK returns them.**
The KMS signed a specific byte layout — `finalizeDraw` verifies against those exact bytes via
`FHE.checkSignatures`; a hand-rolled re-encoding will fail signature verification.

### 6. Error handling

| Scenario | What happens | Where |
|---|---|---|
| Depositing without setting Vault as operator | `ERC7984UnauthorizedSpender(from, spender)` | `confidentialTransferFrom`'s own check, inside `deposit()` |
| Requesting a draw before the window elapses | `"PrizePool: too early"` | `requestDraw()`'s own guard |
| Requesting a draw while one is pending | `"PrizePool: draw already in progress"` | `requestDraw()`'s own guard |
| Finalizing a draw with no pending request | `"PrizePool: no draw pending"` | `finalizeDraw()`'s own guard |
| Non-admin/keeper calling `requestDraw()`/`finalizeDraw()` | `"PrizePool: not admin or keeper"` | `onlyAdminOrKeeper` modifier |
| Withdrawing with no prior deposit | Reverts (uninitialized ciphertext handle) | `withdraw()` → `token.confidentialTransfer` |
| Decrypting a handle you don't own | `UserNotAuthorizedForDecrypt(handle, address)` | Relayer/KMS ACL check, not the frontend |
| Wrong network | Thrown client-side before any call | §1 network guard |
| Non-PrizePool calling `Reserve.releaseTo()` | `"Reserve: not prize pool"` | `onlyPrizePool` modifier |
| Reserve underfunded at draw time | Draw silently skips (`DrawSkipped` event), no revert | `finalizeDraw()`'s budget check |

All covered by tests in
[`vaultshot-contracts(v2)/test/VaultShot.t.sol`](vaultshot-contracts(v2)/test/VaultShot.t.sol)
(22 tests, all passing).

## Development

```bash
cd vaultshot-contracts(v2)
forge soldeer install
forge build
forge test -vvv                                  # 22 tests against the FHEVM mock

forge script script/DeployVaultShot.s.sol \
  --rpc-url <RPC> --account <keystore-name> --broadcast
```

---

# Part 2 — The Pitch (V2)

*(Also available as a slide deck: [`vaultshot-contracts(v2)/docs/VaultShot-Pitch-Deck.pdf`](vaultshot-contracts(v2)/docs/VaultShot-Pitch-Deck.pdf))*

## What VaultShot Does

![What VaultShot Does](screenshots/Screenshot%202026-09-06%20at%201.19.59%E2%80%AFPM.png)

- 🔒 **Fully Confidential Balances** — Every deposit, balance, and withdrawal is encrypted
  end-to-end using FHE; nobody, not even the protocol, can see individual amounts.
- 🎲 **Provably Fair, Encrypted Draws** — Winners are selected using native on-chain FHE
  randomness weighted by encrypted balances — verifiable fairness without ever revealing who has
  what.
- 🔓 **Withdraw Anytime, No Loss** — Principal plus any winnings can be withdrawn in a single
  transaction at any time — deposits are never locked or put at risk.

## The Problem

![The Problem](screenshots/Screenshot%202026-09-06%20at%201.19.33%E2%80%AFPM.png)

Traditional no-loss prize savings protocols — like PoolTogether-style designs — expose every
user's deposit size and every draw outcome on a public ledger. There's no financial privacy, and
losers can infer who won just by watching balances change.

## The VaultShot View

![The VaultShot View](screenshots/Screenshot%202026-09-06%20at%201.19.37%E2%80%AFPM.png)

On VaultShot, the chain records that deposits, draws, and withdrawals *happened* — never *how
much*. Only the account holder can decrypt their own balance; everyone else, including the
protocol itself, sees ciphertext.

| | Public ledger, today | Public ledger, on VaultShot |
|---|---|---|
| Deposit size | Visible plaintext amount | Sealed ciphertext |
| Balance | Visible plaintext amount | Sealed ciphertext |
| Draw winner's amount | Visible plaintext amount | "Winner — amount sealed" |

## How It Works

1. **Wrap** — Plaintext stablecoin is wrapped into a confidential token.
2. **Deposit** — A confidential transfer moves the balance into the vault.
3. **Draw** — Encrypted balances feed an encrypted random draw — only the winner learns.
4. **Withdraw** — Anytime, in a single transaction.

## Version Roadmap

![Version Roadmap](screenshots/Screenshot%202026-09-06%20at%201.19.44%E2%80%AFPM.png)

| | V1 — FoggyPot | V2 — VaultShot (current) | V3 — Mainnet (future) |
|---|---|---|---|
| Status | Shipped | Current | Future |
| Deposit boundary | Plaintext ERC-20 deposited directly into the vault, encrypted internally | Assets wrapped into a standalone confidential ERC-7984 token (cUSD) *before* touching the vault — genuine encrypted transfers end to end | Same confidential-native architecture, hardened for production |
| Draw | On-chain FHE randomness over encrypted balances, single-transaction `runDraw()` | Two-phase draw reveal — exposes only the aggregate pool total, never individual balances | Same two-phase mechanism, with a decentralized keeper network driving both phases |
| Withdraw | Two-step: request → decrypt → finalize | Single transaction | Single transaction |
| Yield source | Admin-funded mock reserve | Admin-funded mock reserve | **Confidential integration with Steakhouse Financial's cUSDC vault** — real on-chain yield instead of manual admin funding, routed into the prize budget via a **Liquidation Pair** auction (the same yield → prize-token mechanism pioneered by PoolTogether V5), continuously and permissionlessly, with auction amounts kept confidential where the underlying yield source allows it |
| Automation | Chainlink Automation-shaped keeper contract, phase 1 only | Chainlink Automation-shaped keeper contract, phase 1 only | Decentralized keeper network for full draw automation |
| Scope | Single pool, deployed and tested live on Sepolia | Deployed and tested live on Sepolia, with a complete SDK-based client for real encrypt/decrypt flows | Multi-stablecoin, multi-draw-period pools; full wallet/frontend UX; security audit; mainnet on Ethereum L2s (pending Zama's mainnet-ready fhEVM release) |

See [`vaultshot-mainnet(v3)/VaultShot-Mainnet-Integration.pdf`](vaultshot-mainnet(v3)/VaultShot-Mainnet-Integration.pdf)
for the full V3 mainnet integration plan — grounded in Zama's actual live mainnet infrastructure
(the Zama × Morpho × Steakhouse Financial confidential USDC yield vault, live since June 2026) and
a proposed "Confidential Liquidation Pair" for routing that real yield into VaultShot's prize
budget without ever revealing an individual depositor's contribution.

## Architecture Overview

![Architecture Overview](screenshots/Screenshot%202026-09-06%20at%201.19.49%E2%80%AFPM.png)

```
                       ── User flow ──
Token Wrapper ──▶ Vault (holds encrypted deposits) ◀──▶ Balance Ledger (per-user encrypted state)
   plaintext                                                        │
   → confidential                                                   │
                                                                     │
                    ── Yield & prize flow ──                        │
Reserve (funds the prize budget) ──▶ Prize Pool (aggregate total only) ──▶ Draw Keeper (triggers each round)
                                                                     │
                                             Draw Keeper triggers each round;
                                             the Vault settles winner payouts back to depositors.
```

## Confidentiality Guarantees

| What Stays Encrypted | What's Necessarily Public |
|---|---|
| Individual deposit amounts | That a deposit/withdrawal occurred |
| Per-user balances | Aggregate pool total at draw time |
| Individual withdrawal amounts | The winning address |
| Who holds how much at any time | Contract logic and draw timing |

## Technical Stack

Zama fhEVM · OpenZeppelin Confidential Contracts (ERC-7984) · Foundry · Zama Relayer SDK ·
Ethereum Sepolia

---

# Part 3 — V3: The Mainnet Plan

Full deck: [`vaultshot-mainnet(v3)/VaultShot-Mainnet-Integration.pdf`](vaultshot-mainnet(v3)/VaultShot-Mainnet-Integration.pdf)

Summary of the plan:

- **Zama's mainnet is live.** Zama Protocol launched on Ethereum on December 30, 2025, and executed
  its first confidential stablecoin transfer (encrypted USDT, cUSDT) on-chain.
- **Confidential USDC yield is also live.** Zama, Morpho, and Steakhouse Financial launched the
  **Steakhouse Confidential Prime USDC** vault — the first DeFi yield product for confidential USDC
  (cUSDC) on Ethereum — deposits open since June 23, 2026, ~3.5–5% net APY, routed into Steakhouse's
  Prime v2 strategy on Morpho, with deposits batched every 24 hours so individual contributions
  stay hidden.
- **VaultShot doesn't need to invent yield generation for V3 — it needs to plug into what already
  shipped.** V2's Reserve is an admin-funded placeholder for exactly this kind of real, confidential
  yield source.
- **The creative piece: a Confidential Liquidation Pair.** PoolTogether V5's Liquidation Pair
  auctions accrued yield for prize tokens via a continuous gradual Dutch auction. VaultShot's
  version has to run on encrypted yield — so it reveals only a periodic aggregate batch total (the
  same pattern VaultShot already uses for its own draw total, and the same batching-privacy model
  Steakhouse's own vault uses for deposits), never any individual depositor's contribution.
- **Milestones:** security audit → Reserve↔Steakhouse vault integration → build the Confidential
  Liquidation Pair → decentralized keeper network → multi-pool/multi-asset support → mainnet launch
  on an Ethereum L2.

---

*From FoggyPot to VaultShot to mainnet — building the first truly private no-loss savings
protocol.*
