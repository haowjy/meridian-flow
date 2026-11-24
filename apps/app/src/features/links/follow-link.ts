import { draftItemKey, resolveStoredLinkAddress } from "@meridian/contracts";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import {
  type DocumentAnswer as DocumentEntry,
  goneLinkDocumentId,
  type LinkAnswerCache,
  type LinkFollowOutcome,
  type LinkTarget,
  linkTargetHref,
} from "@/core/editor/links";

export const CHECKING_DELAY_MS = 250;

export type LinkDocumentRef = {
  documentId: string;
  trashed?: true;
  focus?: true;
  review?: {
    draftId: string;
    itemKey: string;
    contextLocation: { scheme: ContextUriScheme; path: string };
    documentName: string;
  };
};

export type LinkDestination = (document: LinkDocumentRef) => Promise<unknown>;

export type FollowPolicy = {
  open?: LinkDestination;
  missing?: () => void;
};

export type FollowReporter = {
  report(outcome: LinkFollowOutcome): void;
  clear(): void;
};

export async function followProjectLink({
  target,
  ref = null,
  resolution,
  open,
  reporter,
  signal,
  scopeReady,
}: {
  target: LinkTarget;
  ref?: string | null;
  resolution: LinkAnswerCache;
  open: LinkDestination;
  reporter: FollowReporter;
  signal: AbortSignal;
  scopeReady?: Promise<void>;
}): Promise<void> {
  if (signal.aborted) return;
  const link = { ref, href: linkTargetHref(target) };
  const outcome = (state: LinkFollowOutcome["state"]): LinkFollowOutcome => ({
    state,
    target,
    address: resolveStoredLinkAddress(link, resolution.baseUri)?.uri ?? null,
  });

  let settled = false;
  const checking = setTimeout(() => {
    if (!settled && !signal.aborted) reporter.report(outcome("checking"));
  }, CHECKING_DELAY_MS);
  const settle = () => {
    settled = true;
    clearTimeout(checking);
  };

  if (scopeReady) await scopeReady;
  if (signal.aborted) return settle();

  const known = resolution.read(link);
  if (known?.state === "folder") {
    settle();
    reporter.clear();
    return;
  }
  if (known?.state === "gone") {
    settle();
    reporter.clear();
    const documentId = goneLinkDocumentId(known, link);
    if (documentId) await open({ documentId, trashed: true });
    return;
  }
  if (known?.state === "document") {
    settle();
    reporter.clear();
    await open(documentRef(known));
    return;
  }

  const entry = await resolution.resolve(link);
  settle();
  if (signal.aborted) return;

  if (entry?.state === "gone") {
    reporter.clear();
    const documentId = goneLinkDocumentId(entry, link);
    if (documentId) await open({ documentId, trashed: true });
    return;
  }
  if (entry?.state === "document") {
    reporter.clear();
    await open(documentRef(entry));
    return;
  }
  if (entry?.state === "folder") {
    reporter.clear();
    return;
  }
  if (entry?.state !== "missing") {
    reporter.report(outcome("failed"));
    return;
  }
  reporter.report(outcome("missing"));
}

function documentRef(found: DocumentEntry): LinkDocumentRef {
  const { document, draft } = found;
  if (!draft) return { documentId: document.documentId };
  return {
    documentId: document.documentId,
    review: {
      draftId: draft.draftId,
      itemKey: draftItemKey(draft.draftId, document.documentId),
      contextLocation: {
        scheme: document.scheme,
        path: document.path.startsWith("/") ? document.path : `/${document.path}`,
      },
      documentName: document.title,
    },
  };
}
