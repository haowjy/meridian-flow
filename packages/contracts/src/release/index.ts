/**
 * How a running client and the server tell each other which release they are, so an open tab
 * learns it was deployed under. Nothing here refuses a request: the server answers its release
 * and protocol on every response, and the tab decides what that means for itself.
 */
import { z } from "zod";

/** Response header: the release id the server was built as. */
export const RELEASE_HEADER = "x-meridian-release";

/** Request header: the protocol version the sending tab's code speaks. Response header: `current;min=<minimum>`. */
export const PROTOCOL_HEADER = "x-meridian-protocol";

/** The wire contract this code speaks. Bump on a contract change an older tab would misread. */
export const PROTOCOL_VERSION = 1;

/** The oldest protocol the server still understands. Moves only when a compatibility path is deleted. */
export const MIN_PROTOCOL_VERSION = 1;

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
