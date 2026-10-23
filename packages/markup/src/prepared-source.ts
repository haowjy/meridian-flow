/** Source text after ingress preparation, with boundaries mapped to the caller's text. */

export interface PreparedSource {
  value: string;
  /** Present only when preparation changed coordinates. */
  originalOffsets?: readonly number[];
}

export function originalSource(source: string): PreparedSource {
  return { value: source };
}

export function originalOffset(prepared: PreparedSource, offset: number): number {
  return prepared.originalOffsets
    ? (prepared.originalOffsets[offset] ?? prepared.originalOffsets.at(-1) ?? 0)
    : offset;
}
