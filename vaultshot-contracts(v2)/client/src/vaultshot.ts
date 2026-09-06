import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, ZeroHash, type Signer } from "ethers";
import { createInstance, SepoliaConfig, type FhevmInstance } from "@zama-fhe/relayer-sdk/node";

const USDC_ABI = [
  "function faucet()",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

const CUSD_ABI = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function setOperator(address operator, uint48 until)",
  "function confidentialBalanceOf(address account) view returns (bytes32)",
] as const;

const LEDGER_ABI = [
  "function confidentialBalanceOf(address account) view returns (bytes32)",
  "function seeConfidentialBalance(address account) view returns (bytes32)",
  "function getEncryptedBalance(address account) view returns (bytes32)",
  "function balanceOfEncrypted(address account) view returns (bytes32)",
  "function getEncryptedBalances(address[] accounts) view returns (bytes32[])",
  "function depositorsCount() view returns (uint256)",
] as const;

const VAULT_ABI = [
  "function deposit(bytes32 encryptedAmount, bytes inputProof)",
  "function withdraw()",
  "function totalDeposits() view returns (bytes32)",
] as const;

const RESERVE_ABI = [
  "function fund(bytes32 encryptedAmount, bytes inputProof, uint64 plaintextAmount)",
  "function getEncryptedBalance() view returns (bytes32)",
  "function availableBudget() view returns (uint64)",
] as const;

const PRIZEPOOL_ABI = [
  "function requestDraw() returns (bytes32)",
  "function finalizeDraw(bytes abiEncodedTotal, bytes decryptionProof)",
  "function isDrawDue() view returns (bool)",
  "function nextDrawTime() view returns (uint256)",
  "function drawCount() view returns (uint256)",
  "function stage() view returns (uint8)",
  "function grandPrizeAmount() view returns (uint64)",
  "function minorPrizeAmount() view returns (uint64)",
  "event DrawRequested(uint256 indexed drawId, bytes32 totalHandle)",
] as const;

const SEPOLIA_CHAIN_ID = 11155111n;
const RESERVE_FUNDING = 1_000n * 10n ** 6n;

const ADMIN_PRIVATE_KEY = requireEnv("ADMIN_PRIVATE_KEY");
const ALICE_PRIVATE_KEY = requireEnv("ALICE_PRIVATE_KEY");
const BOB_PRIVATE_KEY = requireEnv("BOB_PRIVATE_KEY");
const SEPOLIA_RPC_URL = requireEnv("SEPOLIA_RPC_URL");
const USDC_ADDRESS = requireEnv("USDC_ADDRESS");
const CUSD_ADDRESS = requireEnv("CUSD_ADDRESS");
const LEDGER_ADDRESS = requireEnv("LEDGER_ADDRESS");
const VAULT_ADDRESS = requireEnv("VAULT_ADDRESS");
const RESERVE_ADDRESS = requireEnv("RESERVE_ADDRESS");
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
  return `${(Number(amount) / 1e6).toFixed(2)} cUSD`;
}

/** Encrypts `amount` as a euint64 input bound to `contractAddress` + the sending user. */
async function encryptAmount(instance: FhevmInstance, contractAddress: string, userAddress: string, amount: bigint) {
  const buffer = instance.createEncryptedInput(contractAddress, userAddress);
  buffer.add64(amount);
  const ciphertext = await buffer.encrypt();
  return { handle: ciphertext.handles[0], proof: ciphertext.inputProof };
}

/** Best-effort faucet claim — no-ops (logs) if the 1-hour cooldown hasn't elapsed yet. */
async function tryFaucet(usdc: Contract, signer: Signer, label: string) {
  try {
    const tx = await usdc.connect(signer).getFunction("faucet")();
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

/**
 * The user-requested "give me my address, get back a ciphertext, decrypt it with the SDK" helper
 * — pass any of Ledger's balance-reader aliases, get the handle, then decrypt it. This is the
 * exact pattern client code should use to let a user check their own confidential pool share.
 */
async function seeAndDecryptBalance(
  instance: FhevmInstance,
  ledger: Contract,
  signer: Signer,
  label: string,
): Promise<bigint> {
  const address = await signer.getAddress();
  const handle = (await ledger.seeConfidentialBalance(address)) as string;
  const balance = await decryptEuint64(instance, handle, LEDGER_ADDRESS, signer);
  console.log(`  ${label} (${address}) balance: ${handle === ZeroHash ? "0 (uninitialized)" : fmt(balance)}`);
  return balance;
}

async function main() {
  section("SETUP");

  const provider = new JsonRpcProvider(SEPOLIA_RPC_URL);
  const network = await provider.getNetwork();
  if (network.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Network mismatch: SEPOLIA_RPC_URL points at chain ${network.chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID}). ` +
        `VaultShot is only deployed on Sepolia — check your .env.`,
    );
  }

  const admin = new Wallet(ADMIN_PRIVATE_KEY, provider);
  const alice = new Wallet(ALICE_PRIVATE_KEY, provider);
  const bob = new Wallet(BOB_PRIVATE_KEY, provider);

  console.log("Admin:    ", admin.address);
  console.log("Alice:    ", alice.address);
  console.log("Bob:      ", bob.address);
  console.log("MockUSDC: ", USDC_ADDRESS);
  console.log("cUSD:     ", CUSD_ADDRESS);
  console.log("Ledger:   ", LEDGER_ADDRESS);
  console.log("Vault:    ", VAULT_ADDRESS);
  console.log("Reserve:  ", RESERVE_ADDRESS);
  console.log("PrizePool:", PRIZEPOOL_ADDRESS);

  const instance = await createInstance({ ...SepoliaConfig, network: SEPOLIA_RPC_URL });

  const usdc = new Contract(USDC_ADDRESS, USDC_ABI, provider);
  const cusd = new Contract(CUSD_ADDRESS, CUSD_ABI, provider);
  const ledger = new Contract(LEDGER_ADDRESS, LEDGER_ABI, provider);
  const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, provider);
  const reserve = new Contract(RESERVE_ADDRESS, RESERVE_ABI, provider);
  const prizePool = new Contract(PRIZEPOOL_ADDRESS, PRIZEPOOL_ABI, provider);

  const OPERATOR_UNTIL = 281_474_976_710_655n; // type(uint48).max

  section("FAUCET + WRAP — plaintext USDC in, confidential cUSD out (the wrap boundary)");
  {
    await tryFaucet(usdc, alice, "Alice");
    await tryFaucet(usdc, bob, "Bob");

    for (const [user, label] of [
      [alice, "Alice"],
      [bob, "Bob"],
    ] as const) {
      const usdcBalance = (await usdc.balanceOf(user.address)) as bigint;
      if (usdcBalance === 0n) {
        console.log(`  ${label} has no mUSDC to wrap — skipping wrap for this run.`);
        continue;
      }
      let tx = await usdc.connect(user).getFunction("approve")(CUSD_ADDRESS, usdcBalance);
      await tx.wait();
      tx = await cusd.connect(user).getFunction("wrap")(user.address, usdcBalance);
      console.log(`  ${label} wrap tx:`, tx.hash);
      await tx.wait();

      tx = await cusd.connect(user).getFunction("setOperator")(VAULT_ADDRESS, OPERATOR_UNTIL);
      console.log(`  ${label} setOperator(Vault) tx:`, tx.hash);
      await tx.wait();
    }
  }

  section("RESERVE FUND — admin funds the prize reserve with confidential cUSD (skips if already funded)");
  {
    const currentBudget = (await reserve.availableBudget()) as bigint;
    if (currentBudget >= RESERVE_FUNDING) {
      console.log(`  Reserve already funded (availableBudget = ${fmt(currentBudget)}) — skipping.`);
    } else {
      const cusdBalance = (await cusd.confidentialBalanceOf(admin.address)) as string;
      if (cusdBalance === ZeroHash) {
        console.log("  Admin has no cUSD to fund the reserve with — run the deploy script first.");
      } else {
        let tx = await cusd.connect(admin).getFunction("setOperator")(RESERVE_ADDRESS, OPERATOR_UNTIL);
        await tx.wait();

        const { handle, proof } = await encryptAmount(instance, RESERVE_ADDRESS, admin.address, RESERVE_FUNDING);
        tx = await reserve.connect(admin).getFunction("fund")(handle, proof, RESERVE_FUNDING);
        console.log("  fund tx:", tx.hash);
        await tx.wait();
        console.log(`  Reserve funded with ${fmt(RESERVE_FUNDING)}.`);
      }
    }
  }

  section("DEPOSIT — confidential transfer into the Vault, real encrypted input via the SDK");
  {
    const aliceAmount = 100n * 10n ** 6n;
    const bobAmount = 50n * 10n ** 6n;

    const { handle: aliceHandle, proof: aliceProof } = await encryptAmount(
      instance,
      VAULT_ADDRESS,
      alice.address,
      aliceAmount,
    );
    let tx = await vault.connect(alice).getFunction("deposit")(aliceHandle, aliceProof);
    console.log("  Alice deposit tx:", tx.hash);
    await tx.wait();

    const { handle: bobHandle, proof: bobProof } = await encryptAmount(instance, VAULT_ADDRESS, bob.address, bobAmount);
    tx = await vault.connect(bob).getFunction("deposit")(bobHandle, bobProof);
    console.log("  Bob deposit tx:  ", tx.hash);
    await tx.wait();
  }

  section("BALANCES — after deposit, via every Ledger decrypt-helper alias");
  {
    const aliceHandleA = (await ledger.confidentialBalanceOf(alice.address)) as string;
    const aliceHandleB = (await ledger.seeConfidentialBalance(alice.address)) as string;
    const aliceHandleC = (await ledger.getEncryptedBalance(alice.address)) as string;
    const aliceHandleD = (await ledger.balanceOfEncrypted(alice.address)) as string;
    console.log(
      "  Alias handles match:",
      aliceHandleA === aliceHandleB && aliceHandleB === aliceHandleC && aliceHandleC === aliceHandleD,
    );

    await seeAndDecryptBalance(instance, ledger, alice, "Alice");
    await seeAndDecryptBalance(instance, ledger, bob, "Bob  ");

    const batch = (await ledger.getEncryptedBalances([alice.address, bob.address])) as string[];
    const aliceBatch = await decryptEuint64(instance, batch[0], LEDGER_ADDRESS, alice);
    console.log("  Batch reader — Alice:", fmt(aliceBatch));
  }

  section("DRAW — two-phase: requestDraw() -> off-chain publicDecrypt() -> finalizeDraw()");
  {
    const isDrawDue = (await prizePool.isDrawDue()) as boolean;
    if (!isDrawDue) {
      const nextDrawTime = Number(await prizePool.nextDrawTime());
      const secondsLeft = nextDrawTime - Math.floor(Date.now() / 1000);
      console.log(`  Draw window not open yet — ${secondsLeft}s remaining. Re-run this script after that.`);
    } else {
      let tx = await prizePool.connect(admin).getFunction("requestDraw")();
      console.log("  requestDraw tx:", tx.hash);
      const receipt = await tx.wait();

      const event = receipt.logs
        .map((log: unknown) => {
          try {
            return prizePool.interface.parseLog(log as { topics: string[]; data: string });
          } catch {
            return null;
          }
        })
        .find((parsed: { name: string } | null) => parsed?.name === "DrawRequested");
      const totalHandle = event?.args?.totalHandle as string;
      console.log("  Encrypted total handle:", totalHandle);

      const { clearValues, abiEncodedClearValues, decryptionProof } = await instance.publicDecrypt([totalHandle]);
      const totalDeposits = BigInt(clearValues[totalHandle as `0x${string}`] as string | bigint);
      console.log("  Decrypted total deposits (aggregate only, never individual):", fmt(totalDeposits));

      tx = await prizePool.connect(admin).getFunction("finalizeDraw")(abiEncodedClearValues, decryptionProof);
      console.log("  finalizeDraw tx:", tx.hash);
      await tx.wait();
      console.log("  Draw #", (await prizePool.drawCount()).toString(), "completed.");
    }
  }

  section("BALANCES — after draw (winners will show a higher balance)");
  await seeAndDecryptBalance(instance, ledger, alice, "Alice");
  await seeAndDecryptBalance(instance, ledger, bob, "Bob  ");

  section("WITHDRAW — Alice withdraws her full balance, principal plus any winnings, single tx");
  {
    const balanceBefore = (await usdc.balanceOf(alice.address)) as bigint;
    const tx = await vault.connect(alice).getFunction("withdraw")();
    console.log("  withdraw tx:", tx.hash);
    await tx.wait();

    const cusdBalanceAfter = (await cusd.confidentialBalanceOf(alice.address)) as string;
    const cusdAfter = await decryptEuint64(instance, cusdBalanceAfter, CUSD_ADDRESS, alice);
    console.log("  Alice cUSD balance after withdraw:", fmt(cusdAfter));
    console.log("  (mUSDC balance unchanged at", fmt(balanceBefore), "— withdraw returns cUSD; unwrap() is a separate, optional step.)");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
