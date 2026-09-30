/** Stable sibling-safe names for new Scratch notes. */
export function uniqueScratchNoteName(baseName: string, siblingNames: readonly string[]): string {
  const occupied = new Set(siblingNames);
  if (!occupied.has(baseName)) return baseName;

  const extensionAt = baseName.lastIndexOf(".");
  const stem = extensionAt > 0 ? baseName.slice(0, extensionAt) : baseName;
  const extension = extensionAt > 0 ? baseName.slice(extensionAt) : "";
  let suffix = 2;
  while (occupied.has(`${stem} ${suffix}${extension}`)) suffix += 1;
  return `${stem} ${suffix}${extension}`;
}
