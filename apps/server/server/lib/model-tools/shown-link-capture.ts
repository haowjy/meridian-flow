/**
 * Records what a tool call actually showed the model as shown-link evidence
 * (contract §7.2), and hands the thread's evidence to agent-edit writes
 * (§7.4). Capture lives in the tool handlers that return rendered text, never
 * in `readDocument`, so a copy's private source read records nothing.
 */
import type { WriteOutcome } from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { SpelledLinkFact } from "@meridian/markup";
import type { FileDestination } from "../../domains/file-policy/index.js";
import type { ShownLinkStore } from "../../domains/runtime/index.js";

/** The view links in a result were spelled in, from where the call read or wrote. */
export function destinationView(destination: FileDestination): LinkView {
  return destination.kind === "draft" ? { kind: "draft", workId: destination.workId } : LIVE;
}

export const LIVE: LinkView = { kind: "live" };

/** A read names the version it actually read; a reply's pin can make that live. */
export function readView(outcome: WriteOutcome, destination: FileDestination): LinkView {
  return outcome.result.read?.version === "live" ? LIVE : destinationView(destination);
}

export async function recordShown(
  deps: { shownLinks: ShownLinkStore },
  ctx: { threadId: string; turnId: string },
  shown: {
    documentId: string;
    holderUri: string;
    view: LinkView;
    links: readonly SpelledLinkFact[] | undefined;
  },
): Promise<void> {
  if (!shown.links || shown.links.length === 0) return;
  await deps.shownLinks.record({
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    documentId: shown.documentId,
    holderUri: shown.holderUri,
    view: shown.view,
    links: shown.links,
  });
}

/** `WriteContext.shownLinks` for a thread's agent writes. */
export function threadShownLinks(deps: { shownLinks: ShownLinkStore }, threadId: string) {
  return (documentId: string) => deps.shownLinks.forDocument(threadId, documentId);
}
