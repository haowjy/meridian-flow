/**
 * Shown-link candidates (contract §7.2): what a tool result actually showed
 * the model, returned beside the result as host-only `shown`. Dispatch records
 * them only when it persists the result, so a cancelled or timed-out call
 * leaves no evidence. Facts come from the handlers that return rendered text,
 * never from `readDocument`, so a copy's private source read shows nothing.
 * Also hands the thread's evidence to agent-edit writes (§7.4).
 */
import type { LinkView } from "@meridian/contracts";
import type { SpelledLinkFact } from "@meridian/markup";
import type { ShownLinkShowing, ShownLinkStore } from "../../domains/runtime/index.js";

/** The candidate for one holder, in the view the facts were spelled in; none without facts. */
export function showing(
  documentId: string,
  holderUri: string,
  shown: { shownLinks?: readonly SpelledLinkFact[]; shownView?: LinkView },
): ShownLinkShowing[] {
  const links = shown.shownLinks;
  if (!links || links.length === 0) return [];
  if (!shown.shownView) throw new Error(`Shown links for ${documentId} carry no view.`);
  return [{ documentId, holderUri, view: shown.shownView, links }];
}

/** `WriteContext.shownLinks` for a thread's agent writes. */
export function threadShownLinks(
  deps: { shownLinks: Pick<ShownLinkStore, "forDocument"> },
  threadId: string,
) {
  return (documentId: string) => deps.shownLinks.forDocument(threadId, documentId);
}
