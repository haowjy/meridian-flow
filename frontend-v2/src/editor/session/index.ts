export { DocSession, type DocSessionConfig, type LocalPersistenceHealth } from "./doc-session"
export { SessionPool, type SessionPoolConfig } from "./session-pool"
export {
  ViewController,
  type DocHandle,
  type OpenDoc,
  type ScrollSnapshot,
  type ViewControllerOptions,
  type ViewControllerSnapshot,
  type ViewRestoreState,
} from "./view-controller"
export type {
  ConnectionState,
  DocSyncState,
  DocumentWsProvider,
  DocumentWsProviderFactory,
  FrozenReason,
  ProviderControlEvent,
} from "./types"
export {
  SessionPoolProvider,
  useSessionPool,
  type SessionPoolProviderProps,
} from "./session-pool-context"
export {
  useDocumentSessions,
  type ActiveSessionSnapshot,
  type UseDocumentSessionsResult,
} from "./useDocumentSessions"
export { useFollowActiveDoc } from "./useFollowActiveDoc"
export {
  clearCursorAwareness,
  refreshCursorAwareness,
} from "../collab/awareness-lifecycle"
