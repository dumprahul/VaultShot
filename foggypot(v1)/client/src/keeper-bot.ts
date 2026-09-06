import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const ABI = [
  "function checkUpkeep(bytes) view returns (bool upkeepNeeded, bytes performData)",
  "function performUpkeep(bytes performData)",
] as const;

const ADMIN_PRIVATE_KEY = requireEnv("ADMIN_PRIVATE_KEY");
const SEPOLIA_RPC_URL = requireEnv("SEPOLIA_RPC_URL");
const DRAWKEEPER_ADDRESS = requireEnv("DRAWKEEPER_ADDRESS");

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
// Number of poll ticks to run before exiting. 0 = run forever.
const MAX_TICKS = Number(process.env.MAX_TICKS ?? 1);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Self-hosted replacement for Chainlink Automation (sunset on testnet — see README).
 * Polls DrawKeeper.checkUpkeep() and calls performUpkeep() when a pool's draw window has
 * elapsed. Reuses the exact on-chain logic Chainlink's DON would have called; this script is
 * just what triggers it instead of their network.
 */
async function tick(keeper: Contract, admin: Wallet, tickNumber: number) {
  const timestamp = new Date().toISOString();
  const [upkeepNeeded, performData] = await keeper.checkUpkeep("0x");

  if (!upkeepNeeded) {
    console.log(`[${timestamp}] tick ${tickNumber}: no upkeep needed`);
    return;
  }

  console.log(`[${timestamp}] tick ${tickNumber}: upkeep needed, performing...`);
  const tx = await keeper.connect(admin).getFunction("performUpkeep")(performData);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt.blockNumber}`);
}

const SEPOLIA_CHAIN_ID = 11155111n;

async function main() {
  const provider = new JsonRpcProvider(SEPOLIA_RPC_URL);

  const network = await provider.getNetwork();
  if (network.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Network mismatch: SEPOLIA_RPC_URL points at chain ${network.chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID}).`,
    );
  }

  const admin = new Wallet(ADMIN_PRIVATE_KEY, provider);
  const keeper = new Contract(DRAWKEEPER_ADDRESS, ABI, provider);

  console.log("Keeper bot starting");
  console.log("  DrawKeeper:", DRAWKEEPER_ADDRESS);
  console.log("  Admin:     ", admin.address);
  console.log("  Poll interval:", POLL_INTERVAL_MS, "ms");
  console.log("  Max ticks:", MAX_TICKS === 0 ? "unlimited (Ctrl+C to stop)" : MAX_TICKS);

  let tickNumber = 0;
  while (MAX_TICKS === 0 || tickNumber < MAX_TICKS) {
    tickNumber++;
    try {
      await tick(keeper, admin, tickNumber);
    } catch (err) {
      console.error(`[tick ${tickNumber}] error:`, err);
    }
    if (MAX_TICKS === 0 || tickNumber < MAX_TICKS) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  console.log("Keeper bot finished.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
