// @ts-nocheck
/**
 * Barrel: re-exports the transport layer's public surface — `ThreadTransport`
 * contract + connection/gap types, `WsThreadTransport`, and the multiplexed
 * document collaboration transport (`DocumentSessionTransport` + channels).
 */
export type {
  DocumentChannelError,
  DocumentChannelProvider,
  DocumentSessionTransportOptions,
} from "./document-session-transport";
export {
  DocumentChannel,
  DocumentSessionTransport,
  getDocumentSessionTransport,
  setDocumentSessionTransport,
} from "./document-session-transport";
export type {
  CheckpointRespondInput,
  ConnectionState,
  ThreadGapEvent,
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "./ThreadTransport";
export { WsThreadTransport } from "./WsThreadTransport";
