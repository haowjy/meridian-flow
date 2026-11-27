const PREFIX = "meridian:sign-outs:";

function local(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function signOuts(accountId: string): number {
  return Number(local()?.getItem(`${PREFIX}${accountId}`) ?? 0);
}

export function countSignOut(accountId: string): void {
  local()?.setItem(`${PREFIX}${accountId}`, String(signOuts(accountId) + 1));
}

export function signedInSince(accountId: string): () => boolean {
  const storage = local();
  if (storage && storage.getItem(`${PREFIX}${accountId}`) === null)
    storage.setItem(`${PREFIX}${accountId}`, "0");
  const at = signOuts(accountId);
  return () => signOuts(accountId) === at;
}

export function endOtherSignIns(current: string | null): void {
  const storage = local();
  if (!storage) return;
  const accounts: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX)) accounts.push(key.slice(PREFIX.length));
  }
  for (const account of accounts) if (account !== current) countSignOut(account);
}

export function watchSignOuts(signedIn: () => boolean, ended: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: StorageEvent) => {
    if ((event.key === null || event.key.startsWith(PREFIX)) && !signedIn()) ended();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
