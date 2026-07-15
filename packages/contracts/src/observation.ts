// Durable authority contracts coupling a successful response to exact document prefixes.

import type { DocumentAuthorityId, DocumentId, ResponseCausalCutId } from "./ids.js";

export type ResponseCausalCutV1 = {
  id: ResponseCausalCutId;
  version: 1;
  documentId: DocumentId;
  authorityId: DocumentAuthorityId;
  generation: bigint;
  /** Inclusive contiguous admission prefix within this exact authority generation. */
  admittedThrough: bigint;
};
