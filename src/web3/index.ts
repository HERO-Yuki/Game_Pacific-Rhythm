export type { EthereumReadiness, HexAddress, WalletConnectionState } from "./types";
export {
  connectWalletPlaceholder,
  getEthereumReadiness,
  sendTransactionPlaceholder,
} from "./wallet";
export {
  wallet,
  WalletManager,
  type ConnectPayload,
  type SubmitPayload,
  type WalletErrorCode,
  type WalletResult,
} from "./WalletManager";
