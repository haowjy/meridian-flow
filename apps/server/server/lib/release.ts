/** The release this server was built as and the protocol it speaks; see `@meridian/contracts/release`. */
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ServerProtocol,
} from "@meridian/contracts/release";

/** Replaced at build by `nitro.config.ts`; absent under vitest. */
declare const __MERIDIAN_RELEASE__: string | undefined;

export const RELEASE_ID = typeof __MERIDIAN_RELEASE__ === "string" ? __MERIDIAN_RELEASE__ : "dev";

export function serverProtocol(): ServerProtocol {
  return { current: PROTOCOL_VERSION, minimum: MIN_PROTOCOL_VERSION };
}
