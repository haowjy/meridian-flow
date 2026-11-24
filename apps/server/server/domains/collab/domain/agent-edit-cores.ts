/** Branded agent-edit core types and the grant that authorizes and routes each model call. */
import type { EditCore, WriteContext } from "@meridian/agent-edit/integration";
import type { FileGrant } from "../../file-policy/index.js";

/**
 * A write's context: the edit grant the caller got from the file policy. Its
 * destination routes the call, and the write seams confirm it (file-access §5).
 */
export type RoutedWriteContext = WriteContext & { grant: FileGrant<"edit"> };

/**
 * A read's context. `liveVersion` marks a `version: "live"` read: it reads the live document
 * even when the thread has a Work draft of it, where a default read follows the grant's
 * destination.
 */
export type RoutedReadContext = WriteContext & { grant: FileGrant; liveVersion?: boolean };

/**
 * The model's reads and writes: agent-edit's Loro core on the server's rooms, one for every chat.
 * The call's destination (`runAtDestination`) picks Live or the chat's draft fork.
 */
export type AgentEditCore = Pick<EditCore, "read" | "write">;
