/**
 * What main and the side show, and what a document paints in whichever of them holds it.
 *
 * Main is the address: `resolveMainDocument` is the one order in which an address finds its
 * document, on the desktop and the phone. What sits beside it is `side/side-item.ts`.
 *
 * What a document paints, in whichever host holds it: its view on this device (`document-views`),
 * the pinned owner's draft list, and the Work scope's list for the version chip.
 *
 * ```text
 * pin set, its owner's list not loaded        → pending (never Live first)
 * pin set, the list read failed               → failed (shown on the document, the pin kept)
 * pin set and its item is listed              → that draft
 * pin set and the list lacks its item         → pending, until a fresh read also lacks it and
 *                                               the pin goes (`verifyPin`); then continue
 * otherwise                                   → Live
 * ```
 *
 * The scope never chooses a draft: a document opens on Live, and `scopeDraft` only lets the chip
 * say the picked Work has one. A draft-created document is always pinned to its draft: every way
 * of opening one names it, so it never reaches Live.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { contextOwner, type ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import {
  type DocumentView,
  type DraftPin,
  useDocumentView,
  verifyPin,
} from "@/client/project-shell/document-views";
import { unwrapListQuery } from "@/client/query/list-query";
import { ownerDraftsQueryOptions } from "@/client/query/useOwnerDrafts";
import { type TreeViewResult, useProjectTreeView } from "@/client/query/useProjectTree";
import type { OpenDocument } from "@/client/stores";
import { useAccountId } from "./context/account-feature-context";
import { openDocumentFromFile } from "./context/open-document-from-file";
import { type AddressedDocument, resolveRouteDocumentOwner } from "./context/route-document-owner";
import { useIsDraftOnly } from "./context/use-is-draft-only";
import type { ProjectRouteIssue } from "./routing/ProjectRouteBoundary";
import { contextRouteRequest } from "./routing/project-route";
import { useOptionalChatOnScreen } from "./side/SideView";
import { useScopeDraftOwner } from "./use-work-scope";

export type DocumentPaint = {
  showing: "pending" | "failed" | "draft" | "live";
  /** The draft painted; null unless `showing` is "draft". */
  draft: DraftPin | null;
  /** The painted draft's owner is not the scope's. */
  outOfScope: boolean;
  /** The Work scope's draft owner, whose draft the chip offers; null under No Work. */
  scopeOwnerKey: string | null;
  /** The scope's draft of this document, whether or not it is painted. */
  scopeDraft: DraftPin | null;
  view: DocumentView;
};

type Rows = { status: "loading" | "ready" | "failed"; rows: readonly ThreadDraftListItem[] };
const NO_ROWS: readonly ThreadDraftListItem[] = [];

/** One owner's draft rows; a null owner has none. */
export function useOwnerDraftRows(projectId: string, ownerKey: string | null): Rows {
  const list = unwrapListQuery(
    useQuery({
      ...ownerDraftsQueryOptions(projectId, ownerKey ?? ""),
      select: (response) => response.items,
      enabled: projectReadEnabled(ownerKey !== null),
    }),
  );
  return useMemo(
    () =>
      ownerKey === null || list.status === "disabled"
        ? { status: "ready", rows: NO_ROWS }
        : list.status === "error"
          ? { status: "failed", rows: NO_ROWS }
          : list.data === null
            ? { status: "loading", rows: NO_ROWS }
            : { status: "ready", rows: list.data },
    [ownerKey, list.status, list.data],
  );
}

export function useDocumentPaint(projectId: string, document: OpenDocument | null): DocumentPaint {
  const accountId = useAccountId();
  const documentId = document?.documentId ?? null;
  const view = useDocumentView(accountId, projectId, documentId);
  const scopeOwnerKey = useScopeDraftOwner(projectId, useOptionalChatOnScreen()).ownerKey || null;
  const scopeRows = useOwnerDraftRows(projectId, scopeOwnerKey);
  const pin = view.pin;
  const pinRows = useOwnerDraftRows(
    projectId,
    pin && pin.ownerKey !== scopeOwnerKey ? pin.ownerKey : null,
  );
  const pinList = pin && pin.ownerKey === scopeOwnerKey ? scopeRows : pinRows;
  const pinListed = pin ? pinList.rows.some((row) => row.itemKey === pin.itemKey) : false;
  const pinMissing = pin !== undefined && pinList.status === "ready" && !pinListed;

  const queryClient = useQueryClient();
  const missingKey = pinMissing ? JSON.stringify([pin.ownerKey, pin.itemKey]) : null;
  const scopeRow = documentId
    ? scopeRows.rows.find((row) => row.documentId === documentId)
    : undefined;
  // A document live lacks shows "removed" only when the scope has no draft of it either: its view
  // moves to the scope's draft when the pinned one ends.
  const isDraftOnly = useIsDraftOnly(projectId);
  const successor =
    documentId && scopeOwnerKey && scopeRow && isDraftOnly(documentId)
      ? { documentId, pin: { ownerKey: scopeOwnerKey, itemKey: scopeRow.itemKey } }
      : null;
  const latestSuccessor = useRef(successor);
  latestSuccessor.current = successor;
  useEffect(() => {
    if (!pin || !missingKey) return;
    verifyPin(queryClient, accountId, projectId, pin, (id) => {
      const next = latestSuccessor.current;
      return next?.documentId === id && next.pin.itemKey !== pin.itemKey ? next.pin : null;
    });
  }, [missingKey, queryClient, accountId, projectId]);

  return useMemo((): DocumentPaint => {
    const scopeDraft =
      scopeOwnerKey && scopeRow ? { ownerKey: scopeOwnerKey, itemKey: scopeRow.itemKey } : null;
    const base = { scopeOwnerKey, scopeDraft, view };
    const painted = (draft: DraftPin): DocumentPaint => ({
      ...base,
      showing: "draft",
      draft,
      outOfScope: draft.ownerKey !== scopeOwnerKey,
    });
    if (pin) {
      if (pinListed) return painted(pin);
      return {
        ...base,
        showing: pinList.status === "failed" ? "failed" : "pending",
        draft: null,
        outOfScope: false,
      };
    }
    return { ...base, showing: "live", draft: null, outOfScope: false };
  }, [scopeOwnerKey, scopeRow, view, pin, pinList.status, pinListed]);
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
