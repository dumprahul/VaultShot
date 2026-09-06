import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, ZeroHash, type Signer } from "ethers";
import { createInstance, SepoliaConfig, type FhevmInstance } from "@zama-fhe/relayer-sdk/node";

const TOKEN_ABI = [
  "function faucet()",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

const LEDGER_ABI = ["function confidentialBalanceOf(address account) view returns (bytes32)"] as const;

const RESERVE_ABI = [
  "function confidentialBalance() view returns (bytes32)",
  "function balance() view returns (uint256)",
] as const;

const VAULT_ABI = [
  "function deposit(uint64 amount)",
  "function requestWithdraw()",
  "function finalizeWithdraw(bytes abiEncodedCleartexts, bytes decryptionProof)",
  "function pendingWithdrawHandle(address) view returns (bytes32)",
  "function totalDeposits() view returns (uint64)",
  "function token() view returns (address)",
] as const;

const SEPOLIA_CHAIN_ID = 11155111n;

const PRIZEPOOL_ABI = [
  "function runDraw()",
  "function isDrawDue() view returns (bool)",
  "function nextDrawTime() view returns (uint256)",
  "function drawCount() view returns (uint256)",
  "function grandPrizeAmount() view returns (uint64)",
  "function minorPrizeAmount() view returns (uint64)",
] as const;

const ADMIN_PRIVATE_KEY = requireEnv("ADMIN_PRIVATE_KEY");
const ALICE_PRIVATE_KEY = requireEnv("ALICE_PRIVATE_KEY");
const BOB_PRIVATE_KEY = requireEnv("BOB_PRIVATE_KEY");
const SEPOLIA_RPC_URL = requireEnv("SEPOLIA_RPC_URL");
const TOKEN_ADDRESS = requireEnv("TOKEN_ADDRESS");
const LEDGER_ADDRESS = requireEnv("LEDGER_ADDRESS");
const RESERVE_ADDRESS = requireEnv("RESERVE_ADDRESS");
const VAULT_ADDRESS = requireEnv("VAULT_ADDRESS");
const PRIZEPOOL_ADDRESS = requireEnv("PRIZEPOOL_ADDRESS");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function section(title: string): void {
  console.log(`\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}`);
}

function fmt(amount: bigint): string {
  return `${(Number(amount) / 1e6).toFixed(2)} mUSDC`;
}

/** Best-effort faucet claim — no-ops (logs) if the 1-hour cooldown hasn't elapsed yet. */
async function tryFaucet(token: Contract, signer: Signer, label: string) {
  try {
    const tx = await token.connect(signer).getFunction("faucet")();
    await tx.wait();
    console.log(`  ${label} claimed faucet.`);
  } catch {
    console.log(`  ${label} faucet on cooldown or already funded — skipping.`);
  }
}

/** EIP-712 userDecrypt for any single euint64 handle, signed by `signer`. */
async function decryptEuint64(
  instance: FhevmInstance,
  handle: string,
  contractAddress: string,
  signer: Signer,
): Promise<bigint> {
  if (handle === ZeroHash) return 0n;

  const address = await signer.getAddress();
  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;
  const contractAddresses = [contractAddress];
  const extraData = await instance.getExtraData();

  const eip712 = instance.createEIP712(keypair.publicKey, contractAddresses, startTimestamp, durationDays, extraData);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: [...eip712.types.UserDecryptRequestVerification] },
    eip712.message,
  );

  const result = await instance.userDecrypt(
    [{ handle, contractAddress }],
    keypair.privateKey,
    keypair.publicKey,
    signature.replace("0x", ""),
    contractAddresses,
    address,
    startTimestamp,
    durationDays,
    extraData,
  );

  return BigInt(result[handle as `0x${string}`] as string | bigint);
}

/** Decrypts the caller's own confidentialBalanceOf via a signed userDecrypt request. */
async function decryptBalance(instance: FhevmInstance, ledger: Contract, signer: Signer, label: string) {
  const address = await signer.getAddress();
  const handle = (await ledger.confidentialBalanceOf(address)) as string;
  const balance = await decryptEuint64(instance, handle, LEDGER_ADDRESS, signer);
  console.log(`  ${label} (${address}) balance: ${handle === ZeroHash ? "0 (uninitialized)" : fmt(balance)}`);
  return balance;
}

/** Decrypts Reserve's encrypted mirror balance (only its owner/admin has ACL grant on it). */
async function decryptReserveBalance(instance: FhevmInstance, reserve: Contract, admin: Signer) {
  const handle = (await reserve.confidentialBalance()) as string;
  const balance = await decryptEuint64(instance, handle, RESERVE_ADDRESS, admin);
  console.log(`  Reserve confidential balance: ${handle === ZeroHash ? "0 (uninitialized)" : fmt(balance)}`);
  return balance;
}

async function main() {
  section("SETUP");

  const provider = new JsonRpcProvider(SEPOLIA_RPC_URL);

  const network = await provider.getNetwork();
  if (network.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Network mismatch: SEPOLIA_RPC_URL points at chain ${network.chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID}). ` +
        `FoggyPot is only deployed on Sepolia — check your .env.`,
    );
  }

  const admin = new Wallet(ADMIN_PRIVATE_KEY, provider);
  const alice = new Wallet(ALICE_PRIVATE_KEY, provider);
  const bob = new Wallet(BOB_PRIVATE_KEY, provider);

  console.log("Admin:    ", admin.address);
  console.log("Alice:    ", alice.address);
  console.log("Bob:      ", bob.address);
  console.log("Token:    ", TOKEN_ADDRESS);
  console.log("Ledger:   ", LEDGER_ADDRESS);
  console.log("Vault:    ", VAULT_ADDRESS);
  console.log("PrizePool:", PRIZEPOOL_ADDRESS);

  const instance = await createInstance({ ...SepoliaConfig, network: SEPOLIA_RPC_URL });

  const token = new Contract(TOKEN_ADDRESS, TOKEN_ABI, provider);
  const ledger = new Contract(LEDGER_ADDRESS, LEDGER_ABI, provider);
  const reserve = new Contract(RESERVE_ADDRESS, RESERVE_ABI, provider);
  const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, provider);
  const prizePool = new Contract(PRIZEPOOL_ADDRESS, PRIZEPOOL_ABI, provider);

  // Unsupported/misconfigured token guard: each Vault is hardwired to exactly one immutable
  // ERC-20 at deploy time (see FoggyPotVault — "single confidential token per pool" by design).
  // If .env's TOKEN_ADDRESS doesn't match what this Vault actually accepts, fail loudly now
  // rather than after a deposit approval against the wrong contract.
  const vaultToken = (await vault.token()) as string;
  if (vaultToken.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) {
    throw new Error(
      `Unsupported token: TOKEN_ADDRESS (${TOKEN_ADDRESS}) does not match what Vault ${VAULT_ADDRESS} ` +
        `actually accepts (${vaultToken}). Check your .env addresses are all from the same deployment.`,
    );
  }

  section("FAUCET");
  await tryFaucet(token, alice, "Alice");
  await tryFaucet(token, bob, "Bob");
  console.log("  Alice mUSDC balance:", fmt(await token.balanceOf(alice.address)));
  console.log("  Bob   mUSDC balance:", fmt(await token.balanceOf(bob.address)));

  section("DEPOSIT — plaintext amount, no encryption needed here");
  {
    const aliceAmount = 100n * 10n ** 6n;
    const bobAmount = 50n * 10n ** 6n;

    let tx = await token.connect(alice).getFunction("approve")(VAULT_ADDRESS, aliceAmount);
    await tx.wait();
    tx = await vault.connect(alice).getFunction("deposit")(aliceAmount);
    console.log("  Alice deposit tx:", tx.hash);
    await tx.wait();

    tx = await token.connect(bob).getFunction("approve")(VAULT_ADDRESS, bobAmount);
    await tx.wait();
    tx = await vault.connect(bob).getFunction("deposit")(bobAmount);
    console.log("  Bob deposit tx:  ", tx.hash);
    await tx.wait();
  }

  section("BALANCES — after deposit");
  await decryptBalance(instance, ledger, alice, "Alice");
  await decryptBalance(instance, ledger, bob, "Bob  ");

  section("RESERVE — confidential balance before draw (proves the transfer has a real sender)");
  await decryptReserveBalance(instance, reserve, admin);

  section("DRAW — prize distribution via confidential transfer (Reserve -> winner)");
  const isDrawDue = (await prizePool.isDrawDue()) as boolean;
  if (isDrawDue) {
    const tx = await prizePool.connect(admin).getFunction("runDraw")();
    console.log("  runDraw tx:", tx.hash);
    await tx.wait();
    console.log("  Draw #", (await prizePool.drawCount()).toString(), "completed.");
  } else {
    const nextDrawTime = Number(await prizePool.nextDrawTime());
    const secondsLeft = nextDrawTime - Math.floor(Date.now() / 1000);
    console.log(`  Draw window not open yet — ${secondsLeft}s remaining. Re-run this script after that.`);
  }

  section("RESERVE — confidential balance after draw (should be exactly TOTAL_PRIZE_PER_DRAW lower)");
  await decryptReserveBalance(instance, reserve, admin);

  section("BALANCES — after draw (winners will show a higher balance)");
  await decryptBalance(instance, ledger, alice, "Alice");
  await decryptBalance(instance, ledger, bob, "Bob  ");

  section("WITHDRAW — Alice withdraws her full balance");
  {
    let tx = await vault.connect(alice).getFunction("requestWithdraw")();
    console.log("  requestWithdraw tx:", tx.hash);
    await tx.wait();

    const handle = (await vault.pendingWithdrawHandle(alice.address)) as string;
    console.log("  Pending handle:", handle);

    const { clearValues, abiEncodedClearValues, decryptionProof } = await instance.publicDecrypt([handle]);
    const cleartextAmount = BigInt(clearValues[handle as `0x${string}`] as string | bigint);
    console.log("  Decrypted withdraw amount:", fmt(cleartextAmount));

    const balanceBefore = (await token.balanceOf(alice.address)) as bigint;
    tx = await vault.connect(alice).getFunction("finalizeWithdraw")(abiEncodedClearValues, decryptionProof);
    console.log("  finalizeWithdraw tx:", tx.hash);
    await tx.wait();
    const balanceAfter = (await token.balanceOf(alice.address)) as bigint;

    console.log("  Alice mUSDC balance:", fmt(balanceBefore), "->", fmt(balanceAfter));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
