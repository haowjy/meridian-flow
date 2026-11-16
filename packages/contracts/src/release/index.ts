/**
 * How a running client and the server tell each other which release they are, so an open tab
 * learns it was deployed under. Nothing here refuses a request: the server answers its release
 * and protocol on every response, and the tab decides what that means for itself.
 */
import { z } from "zod";

/** Response header: the release id the server was built as. */
export const RELEASE_HEADER = "x-meridian-release";

/**
 * What a stack that was not built as a release calls itself (`tools/release/release-id.mjs` stamps
 * it on dev builds; an older server's socket frame says "0.0.0"). It tells a tab nothing about a deploy.
 */
export const UNNAMED_RELEASES: readonly string[] = ["dev", "0.0.0"];

/** Response header: `current;min=<minimum>`, the protocol the server speaks and the oldest it still understands. */
export const PROTOCOL_HEADER = "x-meridian-protocol";

/**
 * The wire contract this code speaks. Bump on a contract change an older tab would misread.
 * 2: a move between a project and the account's files became a Copy (#1598). 3: Redo is gone from
 * the chat card and from the AI's commands, and each document command answers with what happened to
 * its items (PR B); a tab built at 2 still sends Redo and expects its statuses. 4: the home folder
 * belongs to the account, so a source's owner has a new shape (#1599), and a chat card's Undo that
 * left every tree change answers `not_undone`, each tree part saying why it stayed (`changed_since`,
 * `purged`) where it said `superseded` (#1636).
 */
export const PROTOCOL_VERSION = 4;

/**
 * The oldest protocol a tab may keep running against this server. Raise it, with
 * `PROTOCOL_VERSION`, when a tab below it can no longer work right here: a request it sends is
 * gone, an answer it would misread, or a control it shows no longer does anything. Those tabs then
 * reload at a pause. Keep a compatibility answer for them until they have reloaded, so nothing they
 * send meanwhile is refused; delete it in a later release.
 */
export const MIN_PROTOCOL_VERSION = 4;

export const serverProtocolSchema = z.object({
  current: z.number().int().nonnegative(),
  minimum: z.number().int().nonnegative(),
});
export type ServerProtocol = z.infer<typeof serverProtocolSchema>;

export function formatServerProtocol({ current, minimum }: ServerProtocol): string {
  return `${current};min=${minimum}`;
}

/** The server's protocol from its response header; null when absent or unreadable. */
export function parseServerProtocol(value: string | null | undefined): ServerProtocol | null {
  const match = /^(\d+);min=(\d+)$/.exec(value?.trim() ?? "");
  return match ? { current: Number(match[1]), minimum: Number(match[2]) } : null;
}
