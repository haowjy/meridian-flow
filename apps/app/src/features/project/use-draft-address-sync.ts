import type { RouterHistory } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useAccountId } from "@/client/account/account-context";
import {
  type DraftPin,
  readDocumentView,
  setDocumentView,
  useDocumentView,
} from "@/client/project-shell/document-views";
import { writeTreeVersionChoice } from "@/client/project-shell/store";
import type { DraftAddressAdmission } from "./use-review-mode";
import { useScopeDraftOwner } from "./use-work-scope";
import { useShownDraft } from "./views";

function samePin(a: DraftPin | null | undefined, b: DraftPin | null | undefined): boolean {
  return a?.draftId === b?.draftId && a?.itemKey === b?.itemKey;
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

export function useDraftAddressSync({
  projectId,
  chatThreadId,
  locationKey: entryKey,
  draftOwner,
  address,
  writeItemKey,
}: {
  projectId: string;
  chatThreadId: string | null;
  locationKey: string | undefined;
  draftOwner: string | null;
  address: {
    itemKey: string | undefined;
    documentId: string | undefined;
    admission: DraftAddressAdmission | undefined;
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
  const arrived = useRef<string | undefined>(undefined);
  const shownOf = useShownDraft(projectId, chatThreadId);
  const stored = useDocumentView(accountId, projectId, documentId ?? null);
  const scopeDraftId = useScopeDraftOwner(projectId, chatThreadId).draftId || null;

  useLayoutEffect(() => {
    if (locationKey === undefined || !documentId || arrived.current === locationKey) return;
    if (address.itemKey && (address.admission !== "admitted" || !draftOwner)) return;
    arrived.current = locationKey;
    const next =
      address.itemKey && draftOwner ? { draftId: draftOwner, itemKey: address.itemKey } : null;
    if (next && next.draftId === scopeDraftId)
      writeTreeVersionChoice(accountId, projectId, "draft");
    const current = readDocumentView(accountId, projectId, documentId).pin;
    if (samePin(next, current) || (!next && !current)) return;
    setDocumentView(accountId, projectId, documentId, next ? { pin: next } : { version: "live" });
  }, [documentId, locationKey, draftOwner, address, accountId, projectId, scopeDraftId]);

  useEffect(() => {
    if (!documentId || arrived.current !== locationKey) return;
    // The store, not this render's pin: the arrival above set the pin in this same commit, and the
    // render's older pin would write the address back to what the arrival replaced.
    const shown = shownOf(documentId);
    if ((address.itemKey ?? null) === (shown?.itemKey ?? null)) return;
    writeItemKey(shown ?? null);
  }, [documentId, locationKey, address.itemKey, stored, shownOf, writeItemKey]);
}
