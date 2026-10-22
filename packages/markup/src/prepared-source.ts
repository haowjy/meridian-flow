/** Source text after ingress preparation, with boundaries mapped to the caller's text. */

export interface PreparedSource {
  value: string;
  /** One original-source offset for each boundary in `value`. */
  originalOffsets: readonly number[];
}

export function originalSource(source: string): PreparedSource {
  return { value: source, originalOffsets: Array.from({ length: source.length + 1 }, (_, i) => i) };
}

export function originalOffset(prepared: PreparedSource, offset: number): number {
  return prepared.originalOffsets[offset] ?? prepared.originalOffsets.at(-1) ?? 0;
}
