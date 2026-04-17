import type { EthereumReadiness, HexAddress } from "./types";

declare global {
  interface Window {
    ethereum?: {
      request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

export function getEthereumReadiness(): EthereumReadiness {
  return {
    providerAvailable: typeof window !== "undefined" && !!window.ethereum,
  };
}

/**
 * Placeholder: replace with a real connect flow (e.g. eth_requestAccounts).
 */
export async function connectWalletPlaceholder(): Promise<HexAddress | null> {
  const readiness = getEthereumReadiness();
  if (!readiness.providerAvailable) {
    console.info("[web3] No window.ethereum — skipping wallet connect (placeholder).");
    return null;
  }
  return null;
}

/**
 * Placeholder for contract reads / writes after you add viem or ethers.
 */
export async function sendTransactionPlaceholder(): Promise<null> {
  return null;
}
