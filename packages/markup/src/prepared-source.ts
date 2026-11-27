export interface PreparedSource {
  value: string;
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
