// Root-identity holds shared by writer and model inverse policies.
import { prepareEditRoots } from "@meridian/agent-edit/integration";
import type { InverseDocument } from "./turn-inverse-service.js";
/** Hold evidence is immutable for this locked invocation, shared by both availability runs. */
export function prepareHolds(documents: InverseDocument[]) {
  return new Map(
    documents.map((document) => {
      const liveIndex = prepareEditRoots(document.live, document.history);
      const views = new Map([[null as string | null, liveIndex]]);
      for (const [id, draft] of document.drafts) views.set(id, liveIndex.forView(draft.doc));
      const heldRoots = new Map<string, Set<string>>();
      for (const part of document.history) {
        if (part.kind === "write" || part.placement.kind !== "pending") continue;
        const id = part.placement.branchId,
          draft = document.drafts.get(id);
        if (!draft) continue;
        const roots = heldRoots.get(id) ?? new Set<string>();
        for (const root of liveIndex.roots(part.effect)) roots.add(root);
        heldRoots.set(id, roots);
      }
      const union = new Set([...heldRoots.values()].flatMap((roots) => [...roots]));
      const live = new Map(liveIndex.inspect(union).map((entry) => [entry.root, entry.identity]));
      const holds = new Map<string, Set<string>>();
      for (const [id, roots] of heldRoots) {
        for (const entry of (views.get(id) ?? liveIndex).inspect(roots)) {
          if (entry.identity === live.get(entry.root)) continue;
          const holders = holds.get(entry.root) ?? new Set<string>();
          holders.add(id);
          holds.set(entry.root, holders);
        }
      }
      return [document.documentId, { views, liveIndex, holds }] as const;
    }),
  );
}
