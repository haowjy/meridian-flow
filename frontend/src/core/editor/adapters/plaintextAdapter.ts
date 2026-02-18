/**
 * Plaintext Content Adapter
 *
 * Simple pass-through adapter for plaintext documents.
 * AI integration is handled by the collab/Yjs proposal system.
 */

import { createTextPassThroughAdapter } from "./createTextPassThroughAdapter";

export const plaintextAdapter = createTextPassThroughAdapter("plaintext");
