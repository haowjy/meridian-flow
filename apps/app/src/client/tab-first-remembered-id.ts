/** Tab-local selection, with a device seed only for a tab's first read. */
export function rememberedIdKey(
  kind: "chat" | "work",
  accountId: string,
  projectId: string,
): string {
  return `meridian:current-${kind}:v1:${accountId}:${projectId}`;
}

function read(storage: "sessionStorage" | "localStorage", key: string): string | null | undefined {
  try {
    const raw = window[storage].getItem(key);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return value === null || (typeof value === "string" && value.length > 0) ? value : undefined;
  } catch {
    return undefined;
  }
}

function write(storage: "sessionStorage" | "localStorage", key: string, id: string | null): void {
  try {
    window[storage].setItem(key, JSON.stringify(id));
  } catch {
    // Storage is best-effort; callers retain the live selection in memory.
  }
}

export function readRememberedId(
  kind: "chat" | "work",
  accountId: string,
  projectId: string,
): string | null {
  const key = rememberedIdKey(kind, accountId, projectId);
  const tab = read("sessionStorage", key);
  if (tab !== undefined) return tab;
  const seed = read("localStorage", key) ?? null;
  // Freeze even an empty seed, so another tab cannot choose this tab's chat later.
  write("sessionStorage", key, seed);
  return seed;
}

export function writeRememberedId(
  kind: "chat" | "work",
  accountId: string,
  projectId: string,
  id: string | null,
): void {
  const key = rememberedIdKey(kind, accountId, projectId);
  // Independent attempts: a failed tab write must not prevent updating the seed.
  write("sessionStorage", key, id);
  write("localStorage", key, id);
}
