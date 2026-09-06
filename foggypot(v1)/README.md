# FoggyPot

Confidential no-loss prize savings on ETH Sepolia, built on the Zama Protocol (fhEVM). Deposits
and balances stay encrypted on-chain; draws are provably fair and deposit-weighted using native
FHE randomness over encrypted balances; prizes move via a genuine confidential transfer; only a
winner learns they won; principal is withdrawable at any time.

Recreates PoolTogether's no-loss prize savings mechanic with confidentiality as the core addition:
nobody but you can see your balance, and nobody but a winner can see who won a draw.

## Deployed contracts (Sepolia)

| Contract | Demo (5 min) | Standard (24 hr) | Long-horizon (30 day) |
|---|---|---|---|
| Ledger | `0xbbafE57B78c1e87fD34bA0FC6A72674c915Fa755` | `0x36edF2329bb1132AA50AA2e65Bec337fFC326875` | `0xDD2b66e37f3860De48d312cc4C1b9e0A0444fFe7` |
| Vault | `0x347F1c2De1BDcC6B32a10ca55E04dbd83825A107` | `0xcc1BF04Ce9Ad5007F22C0134e1323Df4c590c2aD` | `0x62242007D27f52c1669798147b52Ad44a19656A4` |
| Reserve | `0x2806a293fCd27FCC613f8300B457D9f58eC61e6C` | `0xA011aE90a79916de6Ea3E0E312e51ba088E1a6b5` | `0xe9E1dFBf326e9923F747671e0Eb323A1435E7eEA` |
| PrizePool | `0x639B203CB350F0C8c3c4cdf291d72Ef824b907dA` | `0x5C22E6E30d8E12e9a050541BEfE0569E86C6769C` | `0x3424A6869bF652aD52F912Ba9BE943ccC9F8A4bB` |

- **MockUSDC** (shared test token, all 3 pools): `0xEF2574b83A3E3DB6E23C10Fd4658fcCC4aE9b06A`
- **DrawKeeper** (shared, all 3 pools): `0xd8eD5fE2A19Fe475788Fa5cA47fE3805aFd43b8B`

## Getting the test token

`MockUSDC` has a public faucet, 1,000 mUSDC per call, 1-hour cooldown per address:

```solidity
MockUSDC(0xEF2574b83A3E3DB6E23C10Fd4658fcCC4aE9b06A).faucet()
```

## Full cycle: deposit → draw → claim → withdraw

| Stage | Caller | Function | What happens |
|---|---|---|---|
| Deposit | User | `Vault.deposit(uint64 amount)` | Pulls the plaintext ERC-20 in, encrypts the amount, credits your balance in the Ledger |
| Draw | Admin or a keeper | `PrizePool.runDraw()` | `FHE.randEuint64` + a running-sum comparison loop over encrypted balances picks each tier's winner(s); each tier's prize moves as a **confidential transfer** — an `FHE.sub` debit from `Reserve`'s own encrypted balance paired with an `FHE.select`-gated credit to whichever participant the draw lands on |
| Claim | Winner, off-chain | EIP-712 `userDecrypt` via the Zama Relayer SDK | The prize was already credited during `runDraw()`. "Claiming" is just privately decrypting your own updated balance — nobody else's screen shows anything |
| Withdraw | User | `Vault.requestWithdraw()` then `Vault.finalizeWithdraw(...)` | Two-step: your balance is marked publicly decryptable and zeroed, then (after fetching the KMS decryption proof off-chain via `publicDecrypt`) the real ERC-20 is sent back |

A full working reference implementation of every step is in
[`client/src/foggypot.ts`](client/src/foggypot.ts):

```bash
cd client
npm install
cp .env.example .env   # fill in your keys + the addresses above
npm run start
```

---

## Architecture

| Contract | Responsibility |
|---|---|
| `FoggyPotVault` | Deposit/withdraw entry point. Pulls in the plaintext ERC-20, encrypts the amount, credits the depositor via the Ledger. Owns the two-step withdraw (request + finalize) flow and `totalDeposits`, the plaintext lottery-weight bound. |
| `FoggyPotBalanceLedger` | Encrypted per-user deposit weight (`mapping(address => euint64)`). Balance-at-draw-time only — no history, no TWAB. |
| `FoggyPotPrizePool` | Owns the draw lifecycle. `runDraw()` generates `FHE.randEuint64`, runs a per-tier running-sum comparison loop over encrypted balances, and distributes each tier's prize as a confidential transfer out of `Reserve`. |
| `FoggyPotReserve` | Holds this pool's admin-funded mock yield, in the same token the pool accepts, **plus a mirrored encrypted balance** (`confidentialBalance`) — the actual sender side of the confidential transfer. No conversion, no cross-pool sharing. |
| `FoggyPotDrawKeeper` | Automation entry point shared by all pools, implementing Chainlink's `checkUpkeep`/`performUpkeep` interface (also callable by [`client/src/keeper-bot.ts`](client/src/keeper-bot.ts) — see below). `checkUpkeep()` finds whichever pool's window has elapsed; `performUpkeep()` calls its `runDraw()`. |
| `MockUSDC` | Plaintext test ERC-20 with a public faucet — the one asset all three pools accept. |
| FHEVM Executor + ACL | Protocol-level (not written here). Executor logs FHE operations as events; ACL tracks who may decrypt which ciphertext handle. |
| Coprocessor / Gateway / KMS | Off-chain Zama infrastructure. Performs the homomorphic computations, orchestrates decryption requests, threshold-decrypts only when the ACL permits it. |

Three deployments of the identical contract stack, parameterized only by `drawPeriod`: 5 minutes
(demo), 24 hours (standard), 30 days (long-horizon). Pools never interact.

---

## Frontend integration guide

Everything below is exactly what [`client/src/foggypot.ts`](client/src/foggypot.ts) and
[`client/src/keeper-bot.ts`](client/src/keeper-bot.ts) do — this section just documents it
standalone so you can wire up your own frontend without reading the reference client first.

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

**Network-mismatch guard** — check this before anything else; FoggyPot only exists on Sepolia:

```ts
const network = await provider.getNetwork();
if (network.chainId !== 11155111n) throw new Error("Wrong network — connect to Sepolia.");
```

**Unsupported-token guard** — each `Vault` is hardwired to exactly one immutable ERC-20 at deploy
time (single confidential token per pool, by design). If your addresses come from a config file
that could drift, sanity-check them before letting a user approve/deposit:

```ts
const vault = new Contract(VAULT_ADDRESS, ["function token() view returns (address)"], provider);
const actualToken = await vault.token();
if (actualToken.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) {
  throw new Error("TOKEN_ADDRESS doesn't match what this Vault accepts.");
}
```

### 2. There is no encryption step for FoggyPot's own functions

Unlike a raw ERC-7984 token's `confidentialTransfer`/`confidentialMint` (which take an
`externalEuint64` + input proof you build client-side), **every FoggyPot function a user calls
takes plaintext arguments** — `deposit(uint64 amount)`, `requestWithdraw()`, `finalizeWithdraw(...)`
(whose two `bytes` arguments come pre-built from the SDK's own `publicDecrypt`, not from you). You
never call `instance.createEncryptedInput(...)` anywhere in this app. The only SDK calls you need
are the two **decryption** ones below.

### 3. Decrypting a balance (EIP-712 `userDecrypt`)

Used for: your own Ledger balance, and (if you're the pool admin) Reserve's confidential balance.

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

// Your own balance:
const ledger = new Contract(LEDGER_ADDRESS, ["function confidentialBalanceOf(address) view returns (bytes32)"], provider);
const handle = await ledger.confidentialBalanceOf(userAddress);
const balance = await decryptEuint64(handle, LEDGER_ADDRESS, userSigner);
```

**This only works for the account that's actually allowed to see that handle.** ACL permission is
per-account — Bob signing a request for Alice's handle reverts, even with a perfectly valid
signature (`UserNotAuthorizedForDecrypt`). This is what makes "winner-only decryption" real, not
just a convention: it's enforced by the relayer/KMS, not by the frontend hiding a button.

### 4. Functions to call, end to end

| # | Function | Who calls it | Args | Notes |
|---|---|---|---|---|
| 1 | `MockUSDC.faucet()` | Any user | — | 1,000 mUSDC, 1hr cooldown per address |
| 2 | `MockUSDC.approve(vaultAddress, amount)` | User | `spender, amount` | Standard ERC-20 approval before depositing |
| 3 | `Vault.deposit(amount)` | User | `uint64 amount` | Plaintext amount — no encryption needed (see §2) |
| 4 | `Ledger.confidentialBalanceOf(address)` / `Ledger.seeConfidentialBalance(address)` | Anyone (read) | `address` | Two names, identical behavior — both return the same ciphertext handle; decrypt with §3 to get a number |
| 5 | `PrizePool.isDrawDue()` | Anyone (read) | — | `true` once the window has elapsed |
| 6 | `PrizePool.runDraw()` | **Admin or registered keeper only** | — | Not user-callable. Reverts `"PrizePool: not admin or keeper"` otherwise |
| 7 | `Vault.requestWithdraw()` | User | — | Snapshots + zeroes your balance, marks it publicly decryptable |
| 8 | `Vault.pendingWithdrawHandle(address)` | Anyone (read) | `address` | The handle from step 7, needed for step 9 |
| 9 | *(off-chain)* `instance.publicDecrypt([handle])` | User's client | — | Returns `{ clearValues, abiEncodedClearValues, decryptionProof }` — see §5 |
| 10 | `Vault.finalizeWithdraw(abiEncodedClearValues, decryptionProof)` | User | *pass through verbatim from step 9* | Sends the real ERC-20 back |

### 5. Withdrawing (`publicDecrypt`, not `userDecrypt`)

Withdrawal needs the **contract itself** to learn a plaintext amount (to call `ERC20.transfer`),
not just you privately — so it uses the relayer's public-decryption path instead:

```ts
let tx = await vault.connect(user).requestWithdraw();
await tx.wait();

const handle = await vault.pendingWithdrawHandle(userAddress);
const { abiEncodedClearValues, decryptionProof, clearValues } = await instance.publicDecrypt([handle]);
console.log("Withdrawing:", clearValues[handle]);

tx = await vault.connect(user).finalizeWithdraw(abiEncodedClearValues, decryptionProof);
await tx.wait();
```

**Pass `abiEncodedClearValues` and `decryptionProof` through exactly as the SDK returns them.**
Don't try to reconstruct the encoded-cleartext bytes yourself from the plain number — the KMS
signed a *specific* byte layout (one `uint256` per handle, flat-tuple ABI-encoded), and
`Vault.finalizeWithdraw` verifies against those exact bytes via `FHE.checkSignatures`. A
hand-rolled re-encoding (even one that happens to match a local mock) will fail signature
verification against the real network.

### 6. Reserve's confidential balance (admin/observability)

`Reserve.confidentialBalance()` returns the encrypted mirror of its real token balance — the
actual "sender" side of each draw's confidential transfer. Only the Reserve's owner (pool admin)
has ACL permission to decrypt it, via the same `decryptEuint64` helper from §3, contract address
= the Reserve's:

```ts
const reserve = new Contract(RESERVE_ADDRESS, ["function confidentialBalance() view returns (bytes32)"], provider);
const handle = await reserve.confidentialBalance();
const remaining = await decryptEuint64(handle, RESERVE_ADDRESS, adminSigner);
```

### 7. Triggering draws — admin/keeper flow

`runDraw()` is gated to the pool's admin or its registered `keeper` address — never callable by an
ordinary user. Two ways to trigger it:

```ts
// Direct (admin wallet):
await prizePool.connect(adminSigner).runDraw();

// Via the keeper contract's Automation-shaped interface (what a keeper bot calls):
const [upkeepNeeded, performData] = await drawKeeper.checkUpkeep("0x");
if (upkeepNeeded) await drawKeeper.connect(adminSigner).performUpkeep(performData);
```

[`client/src/keeper-bot.ts`](client/src/keeper-bot.ts) implements exactly this as a small polling
loop — see the Automation section below for why it exists.

### 8. Error handling

| Scenario | What happens | Where |
|---|---|---|
| Missing/insufficient ERC-20 approval | `ERC20InsufficientAllowance(spender, allowance, needed)` | Reverts inside `deposit()`'s `transferFrom` (OZ v5 custom error) |
| Insufficient token balance | `ERC20InsufficientBalance(sender, balance, needed)` | Same call site |
| Zero-amount deposit | `"Vault: zero amount"` | `deposit()`'s own guard |
| Non-admin/keeper calling `runDraw()` | `"PrizePool: not admin or keeper"` | `onlyAdminOrKeeper` modifier |
| Second concurrent withdraw request | `"Vault: withdraw already pending"` | `requestWithdraw()`'s own guard |
| Decrypting a handle you don't own | `UserNotAuthorizedForDecrypt(handle, address)` | Relayer/KMS ACL check, not the frontend |
| Wrong network | Thrown client-side before any call | §1 network guard |
| Misconfigured token/vault pairing | Thrown client-side before any call | §1 token guard |
| Draw called before the window elapses | `"PrizePool: too early"` | `runDraw()`'s own guard |

All covered by tests in [`test/FoggyPot.t.sol`](test/FoggyPot.t.sol)
(`test_depositRevertsWithoutApproval`, `test_depositRevertsWithInsufficientBalance`,
`test_depositRevertsOnZeroAmount`, `test_onlyAdminOrKeeperCanRunDraw`,
`test_cannotRequestWithdrawTwiceConcurrently`, `test_onlyAccountOwnerCanDecryptTheirBalance`).

---

## Prize tiers (public config, not encrypted)

| Tier | Share of draw budget | Winners |
|---|---|---|
| Grand | 70% | 1 |
| Minor | 30%, split evenly (10% each) | 3 |

Tier *sizes and winner counts* are plaintext — only the balance comparisons that decide *who* wins
stay encrypted. Total on-chain cost per draw scales as `(tiers × winners per tier) × depositor
count`, kept small (1 + 3) for a workable live demo.

## Winner selection, without encrypted division

fhEVM only supports division/modulus by a **plaintext** divisor, never an encrypted one. Each
pool's `Vault.totalDeposits` is deliberately tracked in plaintext — the deposited/withdrawn amount
is already momentarily public in the ERC-20 `transferFrom`/`transfer` at each entry/exit boundary
(see Leakage below), so an aggregate running total leaks nothing beyond what each transaction
already reveals. That makes `FHE.rem(FHE.randEuint64(), totalDeposits)` — modulus by a *plaintext*
divisor — exactly the primitive needed to bound the draw, with no encrypted division involved.

`runDraw()` then walks every depositor once per selection pass, accumulating a running sum of
their **encrypted** balances and comparing it against that one random draw via `FHE.lt`; the first
participant whose cumulative weight exceeds it wins that pass — bigger balance, proportionally
bigger slice of the range, proportionally higher win chance. Grand and Minor tiers each get their
**own** snapshot of balances-at-draw-time, so a Grand winner is still fully eligible for a Minor
prize in the same draw; *within* the Minor tier, each pass zeroes out its winner's weight in that
tier's snapshot so the same person can't be picked twice by the Minor tier alone.

Because a Minor tier's 2nd/3rd pass reuses the *original* `totalDeposits` bound rather than a
shrunk one (computing the true reduced sum would require knowing who was already excluded — the
exact secret being protected), a random draw can occasionally land inside an already-excluded
winner's now-zeroed slice. When that happens the pass simply finds no winner. This is deliberate
and safe, not a bug — see the confidential-transfer section below for where that unclaimed share
ends up.

## Prize distribution: a genuine confidential transfer

Winning credits aren't minted from nowhere — they're a real encrypted-to-encrypted transfer, with
`Reserve` as the always-identifiable sender:

```solidity
// FoggyPotPrizePool._runSelectionPass, once per tier pass:
reserve.debitConfidential(prizeAmount);          // FHE.sub on Reserve's OWN encrypted balance

// ...then, for every participant in the same pass:
euint64 creditAmount = FHE.select(isThisWinner, prize, zero);   // 0 or prizeAmount, encrypted
ledger.credit(participants[i], creditAmount);                    // FHE.add — called on EVERYONE
```

`Reserve.confidentialBalance` mirrors its real ERC-20 holdings in encrypted form (kept in sync by
`fund()`). Each pass's `debitConfidential` is an *unconditional* `FHE.sub` — the amount is public
tier config, only *who* receives the matching credit is secret — while `Ledger.credit()` runs
identically-shaped on every single depositor every pass, winner and losers alike, so there's no
way to infer who won just from watching which storage slot changed.

The real ERC-20 backing still moves separately and in the clear (`Reserve.releaseTo(vault, ...)`,
once per draw, full budget) — that's what lets `Vault.finalizeWithdraw` pay out real tokens later.
The encrypted mirror is bookkeeping for the confidentiality property; the real balance stays
authoritative for solvency (see `runDraw`'s underfunded-reserve check).

**Verified live on Sepolia** (against a prior deployment of this same code — addresses have since
been redeployed, mechanism unchanged) — draw tx
[`0xc5fe9c0e...ec25a52`](https://sepolia.etherscan.io/tx/0xc5fe9c0e7be9cf15256202c3cbb4fc3f574837aa4e4d2571e2b40b073ec25a52):
`Reserve.balance()` dropped exactly 100 mUSDC (real ERC-20 `Transfer` event, Reserve → Vault) while
the encrypted credit went to whichever depositor the on-chain random draw picked — unrecoverable
from the transaction alone.

A second full live run confirmed the encrypted and real sides move in lockstep end to end: deposit
50 → draw credits +80 (Grand + one Minor tier) → `Ledger` balance 130, decrypted via
`seeConfidentialBalance()` and `confidentialBalanceOf()` identically → `Reserve.confidentialBalance()`
and `Reserve.balance()` both dropped exactly 100 → withdrawal returns exactly 130 real mUSDC,
matching the encrypted balance to the token. Every number reconciled exactly across both the
encrypted and plaintext views, with no manual correction needed.

## Confidentiality & Leakage

**Stays encrypted:** individual deposit sizes *after* the entry boundary, running balances, each
draw's random number, every win/lose comparison result, Reserve's remaining confidential balance,
and — until a winner personally decrypts their own balance — who won.

**Leaks by necessity:**
- That a deposit/withdraw transaction happened, and which address sent it (wallet addresses are
  always public).
- The exact deposit amount, momentarily, in the plaintext ERC-20 `transferFrom` at the entry
  boundary.
- The exact withdrawal amount, at the moment of withdrawal, via the public-decryption callback.
- The number of participants in a draw — both indirectly, via on-chain loop length being
  observable through gas usage, and directly, via `Ledger.allDepositors()`/`depositorsCount()`,
  which are public view functions by design (participant addresses were never meant to be secret,
  only their balances).
- Reserve's real (plaintext) ERC-20 balance, and the total per-draw prize budget — both public,
  visible via `Reserve.balance()`.

**Deliberate simplifications, stated openly:**
- Balance-at-draw-time instead of a full time-weighted average (TWAB) — the ring-buffer/binary-
  search machinery PoolTogether uses to resist flash-deposit gaming is largely redundant here,
  since an attacker can't *see* balances to time an attack in the first place.
- Admin-funded Reserve instead of a real yield-generating liquidation auction.
- Admin/keeper-triggered draws instead of a permissionless keeper-incentive auction — there's no
  free off-chain `isWinner()` check left to build a bot economy around, since winner selection had
  to move fully on-chain (nobody outside the contract can read encrypted balances to check for
  themselves).

## Yield mock

There's no real yield source wired up. Each pool's `Reserve` is funded directly by the admin
(`Reserve.fund(amount)`, which credits both its real ERC-20 balance and its encrypted mirror in
lockstep); `PrizePool.runDraw()` pulls a fixed budget from it every draw. This is an explicit,
documented stand-in for what would otherwise be a real yield-generating strategy (lending, LP
fees, etc.) feeding the Reserve continuously.

## Automating draws — Chainlink Automation vs. the keeper bot

`FoggyPotDrawKeeper` implements Chainlink's `checkUpkeep`/`performUpkeep` interface and can be
registered as a standard upkeep. In practice, Chainlink Automation's classic (checkUpkeep/
performUpkeep, v2.1) network has been sunsetting on testnets — a prior registration against an
earlier deployment of this same contract was confirmed accepted on-chain but never actually
executed by the off-chain DON (verified: zero `UpkeepPerformed` events despite the draw condition
sitting `true` for 20+ minutes). That's a platform-level issue, not something fixable in this repo.

**What actually keeps draws live**: [`client/src/keeper-bot.ts`](client/src/keeper-bot.ts), a
small self-hosted script that polls `DrawKeeper.checkUpkeep()` and calls `performUpkeep()` on a
timer — reusing the *exact* same on-chain contract logic Chainlink's DON would have called, just
triggered by us instead of them. Verified live: it flipped a pool's `drawCount` and emitted
`UpkeepPerformed` for real.

```bash
cd client
npm run keeper                                      # one check-and-perform, then exits
MAX_TICKS=0 POLL_INTERVAL_MS=60000 npm run keeper    # runs forever, checks every 60s
```

This is exactly the admin/keeper-triggered liveness model the brief explicitly allows ("An
admin-gated function is used... with Chainlink Automation layered on top for production-style
liveness") — the on-chain interface is there and correctly wired for whenever Automation (or its
CRE successor) is reliably servicing testnets again; the keeper bot is what keeps it live today.

## Development

```bash
forge soldeer install
forge build
forge test -vvv                                  # 17 tests against the FHEVM mock

forge script script/DeployFoggyPot.s.sol \
  --rpc-url <RPC> --account <keystore-name> --broadcast --slow

forge script script/RegisterAutomation.s.sol \
  --rpc-url <RPC> --account <keystore-name> --broadcast   # needs DRAWKEEPER_ADDRESS env var + LINK
```

`--slow` is recommended for deployment: the script sends ~30 sequential transactions across 3
pools, and public RPC nodes can otherwise report success before every one actually lands.
