/**
 * Purpose: Collects protocol submodules behind the @meridian/contracts/protocol entrypoint.
 * Why independent: Protocol exports are the shared wire-contract surface for clients and server adapters.
 * Barrel: re-exports AG-UI, sequence, HTTP, path, transport, WebSocket, and Yjs protocol helpers.
 */

export type {
  ArtifactRef,
  CheckpointRequest,
  Interrupt,
  MeridianError,
} from "../interrupt/index.js";
export {
  checkpointInterrupt,
  componentContentForCheckpoint,
  errorInterrupt,
  httpErrorInterruptBody,
  meridianError,
  meridianErrorFromGateway,
  meridianErrorFromHttpStatus,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromSystem,
  meridianErrorFromTool,
  meridianErrorFromWsBoundary,
  sharedErrorInterrupt,
  wsErrorInterruptPayload,
} from "../interrupt/index.js";
export { blockContentRecord } from "../threads/block-content-record.js";
export { blockPlainText } from "../threads/block-plain-text.js";
export { checkpointIdForBlock } from "../threads/checkpoint-id-for-block.js";
export type { TurnStatus } from "../threads/status.js";
export { isTerminalTurnStatus } from "../threads/status.js";
export * from "./agui.js";
export * from "./billing.js";
export * from "./event-seq.js";
export * from "./filetype.js";
export * from "./http-types.js";
export * from "./paths.js";
export * from "./projects.js";
export * from "./thread-documents.js";
export * from "./transport-serializer.js";
export * from "./ws-protocol.js";
export * from "./yjs-ws.js";
