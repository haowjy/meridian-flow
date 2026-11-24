/**
 * What main and the side show, and what a document paints in whichever of them holds it.
 *
 * Main is the address: `resolveMainDocument` is the one order in which an address finds its
 * document, on the desktop and the phone. What sits beside it is `side/side-item.ts`.
 *
 * What a document paints, in whichever host holds it, is the one version rule (`shownDraft`) over
 * its view on this device (`document-views`) and the sidebar's Live/Draft choice: Live, or a
 * draft. A draft page binds the draft's fork room of the document whether or not the draft has
 * changed it (design §6, "Three page states, one editor"): no list decides it.
 */
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
  showing: "draft" | "live";
  /** The draft painted; null on Live. */
  draft: DraftPin | null;
  /** The painted draft's owner is not the scope's. */
  outOfScope: boolean;
  /** The Work scope's draft owner, whose draft the chip offers; null under No Work. */
  scopeDraftId: string | null;
  view: DocumentView;
};

type Rows = { status: "loading" | "ready" | "failed"; rows: readonly DraftItem[] };
const NO_ROWS: readonly DraftItem[] = [];

/** One owner's draft rows; a null owner has none. */
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

/**
 * The one rule for which version of a document this tab shows, for its paint and for every way
 * of opening it (a tab, a launch, the address):
 *
 * ```text
 * pinned to another owner's draft (a pick in the version menu)      → that draft
 * the toggle on Draft and the scope has a draft                     → the scope's draft
 * otherwise                                                         → Live
 * ```
 *
 * The toggle is the shell's choice (`TreeVersionChoice`). A draft shows whether or not it has
 * changed the document: its page is the plain draft, which forks at the first write.
 */
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

/**
 * `shownDraft` as this tab reads it now, for code that opens a document: what the document's
 * view would paint.
 */
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
  // A page the scope's version doesn't govern shows Live.
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
        showing: "draft",
        draft: { draftId: pinOwner, itemKey: pinItem },
        outOfScope: pinOwner !== scopeDraftId,
      };
    return { ...base, showing: "live", draft: null, outOfScope: false };
  }, [scopeDraftId, view, pinOwner, pinItem]);
}

/** What a view holds. A chat with no id is a new chat's composer; `about` is the document it attaches. */
export type Item =
  | { kind: "document"; documentId: string }
  | { kind: "chat"; chatId: string | null; about?: string };

export type AddressState = "pending" | "failed" | "settled";

/** The address verdict a route issue states: only loading is pending and only error failed. */
export function addressStateOf(issue: ProjectRouteIssue | undefined): AddressState {
  return issue === "loading" ? "pending" : issue === "error" ? "failed" : "settled";
}

/** The document main's address names, as its host paints and binds it. */
export type MainDocument = Readonly<{
  /** The address names a document. */
  requested: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  /** A Work's Scratch route names its owning Work here. */
  workId?: string | null;
  /** A chat's Scratch route names its lineage here, in place of a Work. */
  rootThreadId?: string | null;
  document: OpenDocument | null;
  local: false;
  /** Live lacks the document: the descriptor is built from the address's draft row. */
  draftOnly: boolean;
  /** The list has synced: a document its tree lacks is not there. */
  catalogResolved: boolean;
  /**
   * The readable address's own verdict on its document. It is the only evidence for or
   * against a document the live tree lacks, such as a pending new-document draft's, so
   * absence proves nothing until the address is `settled`. `failed` is a verdict the route
   * boundary shows with its retry; the host neither waits on it nor rejects the route.
   */
  addressState: AddressState;
  isError: boolean;
  isFetching: false;
}>;

export function resolveMainDocument(input: {
  enabled: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  /**
   * The document this route is bound to. A rename of it or a folder above it changes its path
   * at once, so the host finds it by identity while the readable route repairs the URL to the
   * same path.
   */
  boundDocumentId?: string | null;
  /** The document the answered address names (`addressedDocument`). */
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
      local: false,
      draftOnly: false,
      catalogResolved: false,
      addressState: "settled",
      isError: false,
      isFetching: false,
    };
  }
  // Identity before path: a bound document is found wherever its path went.
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
    local: false,
    draftOnly: owner.kind === "draft-only",
    catalogResolved: input.tree.isComplete,
    addressState: input.addressState ?? "settled",
    isError: input.tree.isError,
    isFetching: false,
  };
}

export function useMainDocument(input: {
  enabled: boolean;
  projectId: string;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  /** The document the route is: where the replay puts it, whatever path the address spells. */
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
  /** What main holds; null while its document is still opening or the address names nothing. */
  item: Item | null;
  /** Main's document as its address resolves it; `requested` is false off a document address. */
  document: MainDocument;
};

const MainViewContext = createContext<MainView | null>(null);
export const MainViewProvider = MainViewContext.Provider;

/** What main shows, inside the project view. */
export function useMainItem(): MainView {
  const main = useContext(MainViewContext);
  if (!main) throw new Error("useMainItem requires the project view");
  return main;
}

/** Main's item outside the project view's own tree (the provider may not be mounted). */
export function useOptionalMainItem(): MainView | null {
  return useContext(MainViewContext);
}
