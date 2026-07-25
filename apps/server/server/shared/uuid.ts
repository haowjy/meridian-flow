/**
 * Server-side alias for the shared request-ID wire grammar.
 *
 * The grammar itself lives in `@meridian/contracts/request-id` because the
 * client parses the same IDs out of context URIs. This file exists so server
 * callers keep importing a local path.
 */

export {
  isUuid,
  type ParsedRequestId,
  parseRequestId,
} from "@meridian/contracts/request-id";
