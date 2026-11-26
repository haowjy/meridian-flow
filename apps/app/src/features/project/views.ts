import { type DocumentId, draftItemKey } from "@meridian/contracts";
import type { DraftItem } from "@meridian/contracts/drafts";
import { contextOwner, type ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createContext, useCallback, useContext, useMemo } from "react";
import {
  type DocumentView,
  type DraftPin,
  readDocumentView,
  useDocumentView,
} from "@/client/project-shell/document-views";
import {
  readTreeVersionChoice,
  type TreeVersionChoice,
  useTreeVersionChoice,
} from "@/client/project-shell/store";
import { unwrapListQuery } from "@/client/query/list-query";
import { useOwnerDraftList } from "@/client/query/useOwnerDrafts";
import { type TreeViewResult, useProjectTreeView } from "@/client/query/useProjectTree";
import type { OpenDocument } from "@/client/stores";
import { useAccountId } from "./context/account-feature-context";
import { openDocumentFromFile } from "./context/open-document-from-file";
import { type AddressedDocument, resolveRouteDocumentOwner } from "./context/route-document-owner";
import type { ProjectRouteIssue } from "./routing/ProjectRouteBoundary";
import { contextRouteRequest } from "./routing/project-route";
import { useOptionalChatOnScreen } from "./side/SideView";
import { useScopeDraftOwner } from "./use-work-scope";

export type DocumentPaint = {
  draft: DraftPin | null;
  outOfScope: boolean;
  scopeDraftId: string | null;
  view: DocumentView;
};

type Rows = { status: "loading" | "ready" | "failed"; rows: readonly DraftItem[] };
const NO_ROWS: readonly DraftItem[] = [];

export function useOwnerDraftRows(projectId: string, draftId: string | null): Rows {
  const query = useOwnerDraftList(projectId, draftId ?? "", draftId !== null);
  const list = unwrapListQuery({ ...query, data: query.data?.items });
  return useMemo(
    () =>
      draftId === null || list.status === "disabled"
        ? { status: "ready", rows: NO_ROWS }
        : list.status === "error"
          ? { status: "failed", rows: NO_ROWS }
          : list.data === null
            ? { status: "loading", rows: NO_ROWS }
            : { status: "ready", rows: list.data },
    [draftId, list.status, list.data],
  );
}

export function shownDraft(input: {
  pin: DraftPin | undefined;
  scopeDraftId: string | null;
  documentId: string;
  choice: TreeVersionChoice;
}): DraftPin | undefined {
  const { pin, scopeDraftId } = input;
  if (pin && pin.draftId !== scopeDraftId) return pin;
  if (!scopeDraftId || input.choice !== "draft") return undefined;
  const itemKey = draftItemKey(scopeDraftId, input.documentId as DocumentId);
  return { draftId: scopeDraftId, itemKey };
}

export function useShownDraft(
  projectId: string,
  chatThreadId: string | null,
): (documentId: string) => DraftPin | undefined {
  const accountId = useAccountId();
  const scopeDraftId = useScopeDraftOwner(projectId, chatThreadId).draftId || null;
  // Re-made when the toggle moves, and reads it when called: an address's arrival writes the
  // toggle in the same commit as the follow that calls this.
  const choice = useTreeVersionChoice(accountId, projectId);
  return useCallback(
    (documentId) =>
      shownDraft({
        pin: readDocumentView(accountId, projectId, documentId).pin,
        scopeDraftId,
        documentId,
        choice: readTreeVersionChoice(accountId, projectId),
      }),
    [accountId, projectId, scopeDraftId, choice],
  );
}

export function useDocumentPaint(projectId: string, document: OpenDocument | null): DocumentPaint {
  const accountId = useAccountId();
  const documentId = document?.documentId ?? null;
  const stored = useDocumentView(accountId, projectId, documentId);
  const scopeDraftId = useScopeDraftOwner(projectId, useOptionalChatOnScreen()).draftId || null;
  const choice = useTreeVersionChoice(accountId, projectId);
  const pin = documentId
    ? shownDraft({ pin: stored.pin, scopeDraftId, documentId, choice })
    : undefined;
  const foreign = pin !== undefined && pin.draftId !== scopeDraftId;
  const view = useMemo<DocumentView>(
    () => (foreign || choice === "draft" ? stored : { ...stored, version: "live" }),
    [stored, foreign, choice],
  );
  const pinOwner = pin?.draftId;
  const pinItem = pin?.itemKey;
  return useMemo((): DocumentPaint => {
    const base = { scopeDraftId, view };
    if (pinOwner && pinItem)
      return {
        ...base,
        draft: { draftId: pinOwner, itemKey: pinItem },
        outOfScope: pinOwner !== scopeDraftId,
      };
    return { ...base, draft: null, outOfScope: false };
  }, [scopeDraftId, view, pinOwner, pinItem]);
}

export type Item =
  | { kind: "document"; documentId: string }
  | { kind: "chat"; chatId: string | null; about?: string };

export type AddressState = "pending" | "failed" | "settled";

export function addressStateOf(issue: ProjectRouteIssue | undefined): AddressState {
  return issue === "loading" ? "pending" : issue === "error" ? "failed" : "settled";
}

export type MainDocument = Readonly<{
  requested: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId?: string | null;
  rootThreadId?: string | null;
  document: OpenDocument | null;
  draftOnly: boolean;
  catalogResolved: boolean;
  addressState: AddressState;
  isError: boolean;
}>;

export function resolveMainDocument(input: {
  enabled: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  boundDocumentId?: string | null;
  addressed?: AddressedDocument | null;
  addressState?: AddressState;
  tree: TreeViewResult;
}): MainDocument {
  const base = {
    scheme: input.scheme,
    path: input.path,
    workId: input.workId ?? null,
    rootThreadId: input.rootThreadId ?? null,
  };
  const requested = input.enabled && input.scheme !== null && input.path !== null;
  if (!requested || !input.scheme || !input.path) {
    return {
      ...base,
      requested: false,
      document: null,
      draftOnly: false,
      catalogResolved: false,
      addressState: "settled",
      isError: false,
    };
  }
  const rootThreadId = input.rootThreadId ?? undefined;
  const owner = resolveRouteDocumentOwner({
    locator: contextRouteRequest({
      scheme: input.scheme,
      path: input.path,
      workId: input.workId,
      rootThreadId,
    }),
    boundDocumentId: input.boundDocumentId,
    tree: input.tree.tree,
    addressed: input.addressed,
  });
  const resolved =
    owner.kind === "live"
      ? openDocumentFromFile(input.scheme, owner.file, contextOwner(input.workId, rootThreadId))
      : owner.kind === "draft-only" || owner.kind === "addressed"
        ? owner.document
        : null;
  return {
    ...base,
    requested: true,
    document: resolved,
    draftOnly: owner.kind === "draft-only",
    catalogResolved: input.tree.isComplete,
    addressState: input.addressState ?? "settled",
    isError: input.tree.isError,
  };
}

export function useMainDocument(input: {
  enabled: boolean;
  projectId: string;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  boundDocumentId: string | null;
  addressed?: AddressedDocument | null;
  addressState?: AddressState;
}): MainDocument {
  const requested = input.enabled && input.scheme !== null && input.path !== null;
  const tree = useProjectTreeView(input.projectId, input.scheme ?? "kb", {
    enabled: requested,
    workId: input.workId,
    rootThreadId: input.rootThreadId,
  });
  return useMemo(
    () =>
      resolveMainDocument({
        enabled: input.enabled,
        scheme: input.scheme,
        path: input.path,
        workId: input.workId,
        rootThreadId: input.rootThreadId,
        boundDocumentId: input.boundDocumentId,
        addressed: input.addressed,
        addressState: input.addressState,
        tree,
      }),
    [
      input.boundDocumentId,
      input.addressed,
      tree,
      input.addressState,
      input.enabled,
      input.path,
      input.scheme,
      input.workId,
      input.rootThreadId,
    ],
  );
}

export type MainView = {
  item: Item | null;
  document: MainDocument;
};

const MainViewContext = createContext<MainView | null>(null);
export const MainViewProvider = MainViewContext.Provider;

export function useMainItem(): MainView {
  const main = useContext(MainViewContext);
  if (!main) throw new Error("useMainItem requires the project view");
  return main;
}

export function useOptionalMainItem(): MainView | null {
  return useContext(MainViewContext);
}
