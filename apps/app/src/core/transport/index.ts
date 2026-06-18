/**
 * Barrel: re-exports the transport layer's public surface — `ThreadTransport`
 * contract + connection/gap types, and `WsThreadTransport`.
 */
export type {
  CheckpointRespondInput,
  ConnectionState,
  ThreadGapEvent,
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "./ThreadTransport";
export { WsThreadTransport } from "./WsThreadTransport";
