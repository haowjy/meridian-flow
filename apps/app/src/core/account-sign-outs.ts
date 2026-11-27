import { browserStorage } from "@/client/storage/browser-record";

const PREFIX = "meridian:sign-outs:";

function signOuts(accountId: string): number {
  return Number(browserStorage("local")?.getItem(`${PREFIX}${accountId}`) ?? 0);
}

// A full localStorage refuses the write. The sign-out still runs; only tabs that miss this count
// keep their lifetime, and the server's Join check still stops their words going out as another
// account.
function write(accountId: string, count: number): void {
  try {
    browserStorage("local")?.setItem(`${PREFIX}${accountId}`, String(count));
  } catch (error) {
    reportError(error);
  }
}

export function countSignOut(accountId: string): void {
  write(accountId, signOuts(accountId) + 1);
}

function recordedAccounts(): string[] {
  const storage = browserStorage("local");
  if (!storage) return [];
  const accounts: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX)) accounts.push(key.slice(PREFIX.length));
  }
  return accounts;
}

export function countEverySignOut(): void {
  for (const account of recordedAccounts()) countSignOut(account);
}

export function countSignOutsExcept(current: string): void {
  for (const account of recordedAccounts()) if (account !== current) countSignOut(account);
}

export function signedInSince(accountId: string): () => boolean {
  if (browserStorage("local")?.getItem(`${PREFIX}${accountId}`) === null) write(accountId, 0);
  const at = signOuts(accountId);
  return () => signOuts(accountId) === at;
}

// A page restored from the back-forward cache heard no `storage` event while it was cached.
export function watchSignOuts(signedIn: () => boolean, ended: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if ((event.key === null || event.key.startsWith(PREFIX)) && !signedIn()) ended();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && !signedIn()) ended();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pageshow", onPageShow);
  };
}
