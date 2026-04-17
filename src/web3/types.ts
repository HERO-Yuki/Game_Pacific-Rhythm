/**
 * Minimal types for a future Ethereum integration (viem / ethers / wagmi).
 */

export type HexAddress = `0x${string}`;

export type EthereumReadiness = {
  providerAvailable: boolean;
};

export type WalletConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";
