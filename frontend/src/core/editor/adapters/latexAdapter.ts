/**
 * LaTeX Content Adapter
 *
 * Simple pass-through adapter for LaTeX documents.
 * AI integration is handled by the collab/Yjs proposal system.
 */

import { createTextPassThroughAdapter } from "./createTextPassThroughAdapter";

export const latexAdapter = createTextPassThroughAdapter("latex");
