/**
 * The honest end of a search-match door: when the promised passage cannot be
 * found in the live document, the document still opens and the writer is told
 * why they are not where the row said they would be.
 *
 * A door that silently lands at the top of a chapter is the failure this
 * exists to prevent — the writer would read the wrong paragraph believing it
 * was the one they searched for.
 *
 * **The notice's life belongs to the store, not to whoever is rendering it.**
 * A notice is about a navigation, and navigations keep happening whether or
 * not its document is on screen. Leaving expiry to the component meant
 * switching tabs stranded the notice, so returning to that document days later
 * would greet the writer with a stale complaint about a search they had
 * forgotten. Each notice carries a token so an older expiry can never take a
 * newer notice with it.
 *
 * Client-only module singleton, like the announcement store: nothing here is
 * SSR-rendered, so no per-request isolation is needed.
 */
import { create } from "zustand";

/** Long enough to read one sentence while glancing at the page behind it. */
const NOTICE_LIFETIME_MS = 7_000;

type PassageNotice = { documentId: string; token: number };

const usePassageNoticeStore = create<{ notice: PassageNotice | null }>(() => ({ notice: null }));

let expiry: ReturnType<typeof setTimeout> | null = null;
let issued = 0;

function cancelExpiry(): void {
  if (expiry === null) return;
  clearTimeout(expiry);
  expiry = null;
}

/** Say that a jump into this document could not find the passage it promised. */
export function reportPassageChanged(documentId: string): void {
  issued += 1;
  const token = issued;
  cancelExpiry();
  usePassageNoticeStore.setState({ notice: { documentId, token } });
  expiry = setTimeout(() => dismissPassageNotice(token), NOTICE_LIFETIME_MS);
}

/**
 * Clear the notice. With a token, only the notice that token belongs to — an
 * expiry that has already been queued must not silence the navigation that
 * superseded it.
 */
export function dismissPassageNotice(token?: number): void {
  const { notice } = usePassageNoticeStore.getState();
  if (!notice || (token !== undefined && notice.token !== token)) return;
  cancelExpiry();
  usePassageNoticeStore.setState({ notice: null });
}

/** Whether this document is the one currently owed an explanation. */
export function usePassageNotice(documentId: string | null): boolean {
  return usePassageNoticeStore(
    (state) => documentId !== null && state.notice?.documentId === documentId,
  );
}
