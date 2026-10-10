/** Best-effort browser records with one version and ownership envelope. */
export type RecordStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;
export type StorageSource = "session" | "local" | (() => RecordStorage | null);

export function browserStorage(tier: "session" | "local"): RecordStorage | null {
  return typeof window === "undefined"
    ? null
    : window[tier === "session" ? "sessionStorage" : "localStorage"];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function browserRecord<T>(
  source: StorageSource,
  binding: { key: string; version: number; accountId: string; scope?: string },
  parse: (value: unknown) => T | undefined,
  onError?: (error: unknown) => void,
) {
  const { key, ...stamp } = binding;
  const storage = () => (typeof source === "function" ? source() : browserStorage(source));
  const attempt = <R>(action: () => R): R | undefined => {
    try {
      return action();
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        /* Failure reporting is also best effort. */
      }
      return undefined;
    }
  };
  return {
    read: (): T | undefined =>
      attempt(() => {
        const raw = storage()?.getItem(key);
        if (raw == null) return undefined;
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value)) return undefined;
        if (
          value.version !== binding.version ||
          value.accountId !== binding.accountId ||
          value.scope !== binding.scope
        )
          return undefined;
        return parse(value.payload);
      }),
    // Undefined deletes the record; null remains a valid explicit domain value.
    write: (payload: T | undefined): boolean =>
      attempt(() => {
        const target = storage();
        if (!target) return false;
        if (payload === undefined) {
          if (!target.removeItem) return false;
          target.removeItem(key);
        } else target.setItem(key, JSON.stringify({ ...stamp, payload }));
        return true;
      }) ?? false,
  };
}
