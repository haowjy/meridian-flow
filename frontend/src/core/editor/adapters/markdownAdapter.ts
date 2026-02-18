/**
 * Markdown Content Adapter
 *
 * Simple pass-through adapter for markdown documents.
 * AI integration is handled by the collab/Yjs proposal system.
 */

import { createTextPassThroughAdapter } from "./createTextPassThroughAdapter";

export const markdownAdapter = createTextPassThroughAdapter("markdown");
