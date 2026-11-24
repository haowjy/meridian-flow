export type WorkOwnerRef = {
  workId?: string | null;
  rootThreadId?: undefined;
  rootThreadRef?: undefined;
  chatThreadId?: undefined;
};

export type LineageOwnerRef = {
  workId?: undefined;
  rootThreadId: string;
  rootThreadRef?: string;
  chatThreadId?: undefined;
};

export type ChatOwnerRef = {
  workId?: undefined;
  rootThreadId?: undefined;
  rootThreadRef?: undefined;
  chatThreadId: string;
  chatRef?: string;
};

export type ContextOwner = WorkOwnerRef | LineageOwnerRef | ChatOwnerRef;

export type ResolvedContextOwner =
  | (WorkOwnerRef & { workId: string | null })
  | LineageOwnerRef
  | ChatOwnerRef;

export function contextOwner(
  workId: string | null | undefined,
  rootThreadId?: string | null,
  chatThreadId?: string | null,
): ResolvedContextOwner {
  if (chatThreadId) return { chatThreadId };
  return rootThreadId ? { rootThreadId } : { workId: workId ?? null };
}

export type LineageInfo = {
  rootThreadId: string;
  rootThreadRef: string;
  title: string | null;
};
