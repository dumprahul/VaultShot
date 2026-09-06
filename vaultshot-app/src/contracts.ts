export const ADDRESSES = {
  usdc:      import.meta.env.VITE_USDC_ADDRESS      as string,
  cusd:      import.meta.env.VITE_CUSD_ADDRESS      as string,
  ledger:    import.meta.env.VITE_LEDGER_ADDRESS    as string,
  vault:     import.meta.env.VITE_VAULT_ADDRESS     as string,
  prizePool: import.meta.env.VITE_PRIZEPOOL_ADDRESS as string,
}

// MockUSDC — plaintext faucet token
export const USDC_ABI = [
  'function faucet()',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const

// VaultShotToken (cUSD) — confidential ERC-7984 wrapper
export const CUSD_ABI = [
  'function wrap(address to, uint256 amount)',
  'function setOperator(address operator, uint48 until)',
  'function confidentialBalanceOf(address account) view returns (bytes32)',
] as const

// VaultShotBalanceLedger — encrypted per-user pool shares
export const LEDGER_ABI = [
  'function seeConfidentialBalance(address account) view returns (bytes32)',
  'function confidentialBalanceOf(address account) view returns (bytes32)',
] as const

// VaultShotVault — deposit / withdraw entry point
export const VAULT_ABI = [
  'function deposit(bytes32 encryptedAmount, bytes inputProof)',
  'function withdraw()',
] as const
