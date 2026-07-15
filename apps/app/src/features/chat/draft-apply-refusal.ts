/** Stable UI seam for P2b's Apply refusal payload while its server contract converges. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";

export type DraftApplyRefusal = {
  reason: "stale_draft" | "unsynced_live_edits" | "protected_resurrection";
  passages: Array<{ body: string }>;
};

/** Normalize the wire response in one place; convergence only needs to replace this reader. */
export function draftApplyRefusalFromResponse(
  response: DraftAcceptResponse,
): DraftApplyRefusal | null {
  if (response.status === "stale_draft") return { reason: "stale_draft", passages: [] };

  const candidate = response as unknown as {
    status?: string;
    refusal?: { reason?: string; passages?: Array<{ body?: string; markdown?: string }> };
  };
  if (candidate.status !== "refused" || !candidate.refusal) return null;
  const reason = candidate.refusal.reason;
  if (
    reason !== "stale_draft" &&
    reason !== "unsynced_live_edits" &&
    reason !== "protected_resurrection"
  ) {
    return null;
  }
  return {
    reason,
    passages: (candidate.refusal.passages ?? []).flatMap((passage) => {
      const body = passage.body ?? passage.markdown;
      return body ? [{ body }] : [];
    }),
  };
}
