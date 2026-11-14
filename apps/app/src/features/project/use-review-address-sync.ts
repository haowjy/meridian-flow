/**
 * Main's address and main's document view, kept in step. An address arriving by push, pop or load
 * (a link, a reload, Back) is a command: it sets the view's pin to the draft it names, or drops the
 * pin when it names none; naming the scope's draft also sets the toggle to Draft. A replace is
 * not, unless it changes main's document: it rewrites its entry in place (`arrivalOf`). After that
 * what the document shows (`shownDraft`) is the owner and the address follows it by replace, so a
 * draft the writer picks, leaves, flips the toggle on, or focuses a change in rewrites the address
 * in place and never adds a Back step.
 */
import type { RouterHistory } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  type DraftPin,
  readDocumentView,
  setDocumentView,
} from "@/client/project-shell/document-views";
import { writeTreeVersionChoice } from "@/client/project-shell/store";
import { useAccountId } from "./context/account-feature-context";
import type { ReviewAddressAdmission } from "./use-review-admission";
import { useScopeDraftOwner } from "./use-work-scope";
import { useShownDraft } from "./views";

function samePin(a: DraftPin | null | undefined, b: DraftPin | null | undefined): boolean {
  return a?.ownerKey === b?.ownerKey && a?.itemKey === b?.itemKey && a?.changeId === b?.changeId;
}

const inheritedArrivals = new WeakMap<RouterHistory, Map<string, string>>();

/**
 * The arrival a history entry belongs to: its own key, or for an entry a replace made, the
 * arrival of the entry it replaced. `@tanstack/history` mints a new key on every replace, so the
 * key alone would read the view's own address writes as commands, and an older write landing
 * after a newer pin would reset the pin to it.
 */
function arrivalOf(history: RouterHistory, key: string): string {
  let inherited = inheritedArrivals.get(history);
  if (!inherited) {
    const map = new Map<string, string>();
    let last = history.location.state.__TSR_key;
    history.subscribe(({ location, action }) => {
      const next = location.state.__TSR_key;
      if (action.type === "REPLACE" && last && next) map.set(next, map.get(last) ?? last);
      last = next;
    });
    inheritedArrivals.set(history, map);
    inherited = map;
  }
  return inherited.get(key) ?? key;
}

export function useReviewAddressSync({
  projectId,
  chatThreadId,
  locationKey: entryKey,
  reviewOwner,
  address,
  writeItemKey,
}: {
  projectId: string;
  /** The chat on screen, whose Work's drafts the shell shows under None. */
  chatThreadId: string | null;
  /** The rendered history entry's key. */
  locationKey: string | undefined;
  /** Whose draft the address's item reviews (`addressReviewOwner`); null while unresolved. */
  reviewOwner: string | null;
  address: {
    /** Whose draft the address names; a pin writes its own owner back. */
    owner: string | undefined;
    itemKey: string | undefined;
    changeId: string | undefined;
    /** Main's document, as the address resolved it; undefined when main holds no document. */
    documentId: string | undefined;
    admission: ReviewAddressAdmission | undefined;
  };
  writeItemKey: (review: DraftPin | null) => void;
}) {
  const accountId = useAccountId();
  const { history } = useRouter();
  const { documentId } = address;
  const locationKey =
    entryKey === undefined || !documentId
      ? undefined
      : JSON.stringify([arrivalOf(history, entryKey), documentId]);
  /** The arrival, and main's document in it, whose address main's view has taken in. */
  const arrived = useRef<string | undefined>(undefined);
  // What main's document shows, by the one rule: the address follows it.
  const shownOf = useShownDraft(projectId, chatThreadId);
  const pin = documentId ? shownOf(documentId) : undefined;
  const scopeOwnerKey = useScopeDraftOwner(projectId, chatThreadId).ownerKey || null;

  useLayoutEffect(() => {
    if (locationKey === undefined || !documentId || arrived.current === locationKey) return;
    if (address.itemKey && (address.admission !== "admitted" || !reviewOwner)) return;
    arrived.current = locationKey;
    const next =
      address.itemKey && reviewOwner
        ? {
            ownerKey: reviewOwner,
            itemKey: address.itemKey,
            ...(address.changeId ? { changeId: address.changeId } : {}),
          }
        : null;
    // An address naming the scope's draft is the toggle's Draft: every page shows its draft.
    if (next && next.ownerKey === scopeOwnerKey)
      writeTreeVersionChoice(accountId, projectId, "draft");
    const current = readDocumentView(accountId, projectId, documentId).pin;
    if (samePin(next, current) || (!next && !current)) return;
    setDocumentView(accountId, projectId, documentId, next ? { pin: next } : { version: "live" });
  }, [documentId, locationKey, reviewOwner, address, accountId, projectId, scopeOwnerKey]);

  useEffect(() => {
    if (!documentId || arrived.current !== locationKey) return;
    // The store, not this render's pin: the arrival above set the pin in this same commit, and the
    // render's older pin would write the address back to what the arrival replaced.
    const shown = shownOf(documentId);
    if (
      (address.itemKey ?? null) === (shown?.itemKey ?? null) &&
      address.changeId === shown?.changeId &&
      (!shown || address.owner === shown.ownerKey)
    )
      return;
    writeItemKey(shown ?? null);
  }, [
    documentId,
    locationKey,
    address.itemKey,
    address.changeId,
    address.owner,
    pin,
    shownOf,
    writeItemKey,
  ]);
}
