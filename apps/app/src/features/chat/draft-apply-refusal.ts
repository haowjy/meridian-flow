/** Maps the server's durable draft-base evidence into DraftDock presentation. */
import type {
  DraftAcceptResponse,
  DraftApplyRefusal as DraftApplyRefusalResponse,
} from "@meridian/contracts/drafts";

export type DraftApplyRefusal = {
  reason: "stale_draft" | "unsynced_live_edits" | "protected_resurrection";
  passages: Array<{ body: string }>;
};

export function draftApplyRefusalFromResponse(
  response: DraftAcceptResponse,
): DraftApplyRefusal | null {
  if (response.status === "stale_draft") return { reason: "stale_draft", passages: [] };
  if (response.status !== "concurrent_conflict") return null;

  const refusal: DraftApplyRefusalResponse = response;
  const protectedResurrection = refusal.conflicts.some(
    (conflict) => conflict.effect === "resurrection",
  );
  return {
    reason: protectedResurrection ? "protected_resurrection" : "unsynced_live_edits",
    passages: refusal.conflicts.flatMap((conflict) => {
      const captured =
        conflict.effect === "resurrection" ? conflict.captured.base : conflict.captured.live;
      return captured ? [{ body: bodyFromHashline(captured) }] : [];
    }),
  };
}

function bodyFromHashline(value: string): string {
  const separator = value.indexOf("|");
  return separator < 0 ? value : value.slice(separator + 1).replace(/^\n/, "");
}
