/**
 * Minimal Web3 wallet manager — no external deps.
 *
 * Talks directly to the EIP-1193 `window.ethereum` provider injected
 * by MetaMask / Rabbit / Frame / etc. We deliberately avoid pulling
 * in `ethers` or `viem` so the jam bundle stays small; when the game
 * graduates to real on-chain reads/writes, swap the `.request(...)`
 * calls for the equivalent lib helpers — the public surface of this
 * class is already shaped like a viem / ethers wallet client.
 *
 * All external calls are wrapped in a discriminated-union `Result`
 * so the Scene layer never has to try/catch. EIP-1193 rejection
 * code `4001` is mapped to a clean `user-rejected` reason so the
 * overlay can distinguish "user pressed cancel" from real failures.
 */
import type { HexAddress } from "./types";

/* ============================================================== */
/*  Result plumbing                                               */
/* ============================================================== */

export type WalletErrorCode = "no-provider" | "user-rejected" | "unknown";

export interface WalletOk<T> {
  readonly ok: true;
  readonly data: T;
}

export interface WalletErr {
  readonly ok: false;
  readonly code: WalletErrorCode;
  readonly message: string;
}

export type WalletResult<T> = WalletOk<T> | WalletErr;

export interface ConnectPayload {
  readonly address: HexAddress;
}

export interface SubmitPayload {
  readonly signature: string;
  /** The exact UTF-8 message the user signed — useful for off-chain verify. */
  readonly message: string;
}

/* ============================================================== */
/*  Manager                                                        */
/* ============================================================== */

export class WalletManager {
  private currentAddress: HexAddress | null = null;

  /** `true` when an EIP-1193 provider is present in the page. */
  isProviderAvailable(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.ethereum !== "undefined" &&
      typeof window.ethereum.request === "function"
    );
  }

  /** Last successfully connected address, or `null` if never connected. */
  getAddress(): HexAddress | null {
    return this.currentAddress;
  }

  /**
   * Ask the injected provider to unlock an account and return it.
   *
   * On supporting browsers this triggers the wallet's approval popup
   * (MetaMask etc.). Caches the address on success so callers can
   * skip re-prompting across scene restarts.
   */
  async connectWallet(): Promise<WalletResult<ConnectPayload>> {
    const guard = this.requireProvider();
    if (!guard.ok) return guard;
    try {
      const accounts = (await guard.provider.request!({
        method: "eth_requestAccounts",
      })) as string[];
      if (!Array.isArray(accounts) || accounts.length === 0) {
        return {
          ok: false,
          code: "unknown",
          message: "Wallet returned no accounts.",
        };
      }
      const address = accounts[0] as HexAddress;
      this.currentAddress = address;
      return { ok: true, data: { address } };
    } catch (err) {
      return this.interpretError(err);
    }
  }

  /**
   * Sign an off-chain score attestation with the connected wallet.
   *
   * We use `personal_sign` (EIP-191) rather than a full contract
   * transaction so no gas is paid and no network is required — yet
   * the returned signature is verifiable on-chain later via
   * `ecrecover`, which is exactly the "foundation for on-chain score
   * recording" the challenge asks for.
   */
  async submitScore(
    score: number,
    address: HexAddress,
  ): Promise<WalletResult<SubmitPayload>> {
    const guard = this.requireProvider();
    if (!guard.ok) return guard;
    const message = this.buildScoreMessage(score, address);
    try {
      const signature = (await guard.provider.request!({
        method: "personal_sign",
        params: [message, address],
      })) as string;
      if (typeof signature !== "string" || signature.length === 0) {
        return {
          ok: false,
          code: "unknown",
          message: "Wallet did not return a signature.",
        };
      }
      return { ok: true, data: { signature, message } };
    } catch (err) {
      return this.interpretError(err);
    }
  }

  /**
   * Shared pre-flight for every RPC. Returns either a narrowed
   * provider handle (when the EIP-1193 injection is usable) or a
   * ready-to-return `WalletErr` with `code: "no-provider"` — so
   * callers can early-out with one line instead of repeating the
   * `typeof window` dance twice.
   */
  private requireProvider():
    | { ok: true; provider: NonNullable<Window["ethereum"]> }
    | WalletErr {
    if (!this.isProviderAvailable() || !window.ethereum?.request) {
      return {
        ok: false,
        code: "no-provider",
        message:
          "No Ethereum wallet detected. Install MetaMask to submit scores.",
      };
    }
    return { ok: true, provider: window.ethereum };
  }

  /**
   * Compact wallet display used in cramped UI slots, e.g. on the
   * GAME OVER overlay: `0x1234...abcd`. Falls back to the original
   * string when the input does not look like an Ethereum address.
   */
  static shortAddress(address: string): string {
    if (!address.startsWith("0x") || address.length < 10) return address;
    return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
  }

  /**
   * UTF-8 payload handed to `personal_sign`. Kept multi-line and
   * human-readable so the signing popup in MetaMask clearly shows
   * the user what they are attesting to (score + timestamp).
   */
  private buildScoreMessage(score: number, address: HexAddress): string {
    const iso = new Date().toISOString();
    return [
      "Pacific Rhythm \u2014 Gamedev.js Jam 2026",
      `Player: ${address}`,
      `Kaiju defeated: ${score}`,
      `Date: ${iso}`,
      "",
      "Signing this message proves ownership of the above score.",
      "No transaction will be broadcast and no gas will be paid.",
    ].join("\n");
  }

  /**
   * Map a provider exception to our discriminated error union.
   *
   * EIP-1193 rejection is code `4001`; some older wallets emit the
   * string variant `ACTION_REJECTED`. `-32002` is MetaMask's
   * "a request is already pending" — raised when the popup is
   * already open and the user taps our button again. We surface it
   * as a distinct, friendlier message so the overlay can tell the
   * user to look at the wallet popup rather than re-clicking.
   */
  private interpretError(err: unknown): WalletErr {
    const e = err as { code?: number | string; message?: string };
    if (e?.code === 4001 || e?.code === "ACTION_REJECTED") {
      return {
        ok: false,
        code: "user-rejected",
        message: "Wallet request rejected.",
      };
    }
    if (e?.code === -32002) {
      return {
        ok: false,
        code: "unknown",
        message:
          "A wallet request is already pending. Check your wallet popup.",
      };
    }
    return {
      ok: false,
      code: "unknown",
      message: e?.message ?? "Wallet request failed.",
    };
  }
}

/** Shared instance — scenes should import this directly. */
export const wallet = new WalletManager();
