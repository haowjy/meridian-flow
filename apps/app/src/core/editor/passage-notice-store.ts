import { create } from "zustand";

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

export function reportPassageChanged(documentId: string): void {
  issued += 1;
  const token = issued;
  cancelExpiry();
  usePassageNoticeStore.setState({ notice: { documentId, token } });
  expiry = setTimeout(() => dismissPassageNotice(token), NOTICE_LIFETIME_MS);
}

export function dismissPassageNotice(token?: number): void {
  const { notice } = usePassageNoticeStore.getState();
  if (!notice || (token !== undefined && notice.token !== token)) return;
  cancelExpiry();
  usePassageNoticeStore.setState({ notice: null });
}

export function usePassageNotice(documentId: string | null): boolean {
  return usePassageNoticeStore(
    (state) => documentId !== null && state.notice?.documentId === documentId,
  );
}
