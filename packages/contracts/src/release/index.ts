import { z } from "zod";

export const RELEASE_HEADER = "x-meridian-release";

export const UNNAMED_RELEASES: readonly string[] = ["dev", "0.0.0"];

export const PROTOCOL_HEADER = "x-meridian-protocol";

export const PROTOCOL_VERSION = 8;

export const MIN_PROTOCOL_VERSION = 8;

export const serverProtocolSchema = z.object({
  current: z.number().int().nonnegative(),
  minimum: z.number().int().nonnegative(),
});
export type ServerProtocol = z.infer<typeof serverProtocolSchema>;

export function formatServerProtocol({ current, minimum }: ServerProtocol): string {
  return `${current};min=${minimum}`;
}

export function parseServerProtocol(value: string | null | undefined): ServerProtocol | null {
  const match = /^(\d+);min=(\d+)$/.exec(value?.trim() ?? "");
  return match ? { current: Number(match[1]), minimum: Number(match[2]) } : null;
}
