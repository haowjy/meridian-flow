/** Bounded source-result cache for settled blocks remounted by the virtual transcript. */
export function createDocumentCache<T>() {
  const entries = new Map<string, T>();
  let characters = 0;
  const budget = 250_000;
  return (source: string, compute: () => T): T => {
    if (entries.has(source)) {
      const result = entries.get(source) as T;
      entries.delete(source);
      entries.set(source, result);
      return result;
    }
    const result = compute();
    if (source.length > budget) return result;
    entries.set(source, result);
    characters += source.length;
    while (entries.size > 256 || characters > budget) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      characters -= oldest.length;
      entries.delete(oldest);
    }
    return result;
  };
}
