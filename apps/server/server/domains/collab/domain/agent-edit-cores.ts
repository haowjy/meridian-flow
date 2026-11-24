import type { EditCore, WriteContext } from "@meridian/agent-edit/integration";
import type { FileGrant } from "../../file-policy/index.js";

/**
 * A model call's context: agent-edit's, with the grant the file policy gave the caller. The
 * call's `linkView` is the grant's destination (Live, or the chat's draft), and the host's ports
 * read both from here: the room a call reads and writes, and who an inverse acts for.
 */
export type AgentCallContext = WriteContext & { grant: FileGrant };

/** A write's context: the edit grant the caller got from the file policy (file-access §5). */
export type RoutedWriteContext = AgentCallContext & { grant: FileGrant<"edit"> };

/**
 * A read's context. `liveVersion` marks a `version: "live"` read: it reads the live document
 * even when the thread has a Work draft of it, where a default read follows the grant's
 * destination.
 */
export type RoutedReadContext = AgentCallContext & { liveVersion?: boolean };

/** The model's reads and writes: agent-edit's core on the server's rooms, one for every chat. */
export type AgentEditCore = Pick<EditCore<AgentCallContext>, "read" | "write">;
