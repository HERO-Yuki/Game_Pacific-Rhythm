/**
 * Minimal types for a future Ethereum integration (viem / ethers / wagmi).
 *
 * Everything here is library-free so the jam bundle stays lean. The
 * EIP-1193 `Window.ethereum` augmentation is declared once, here, so
 * multiple web3 modules can share the same narrowed shape without
 * fighting TypeScript's duplicate-global rules.
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

/**
 * Narrow, library-free EIP-1193 provider shape. Matches what
 * MetaMask actually injects into the page in 2024+. Only the
 * fields we touch are modelled; extend as needed when new RPC
 * methods are added.
 */
export interface EthereumProvider {
  request?: (args: {
    method: string;
    params?: unknown[] | object;
  }) => Promise<unknown>;
  isMetaMask?: boolean;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}
