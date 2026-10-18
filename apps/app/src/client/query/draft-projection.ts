/**
 * The one projection of a draft observation under the writer's intents. The
 * observation (a list or preview read) is never edited; what a list, a count, the
 * manuscript's marks and a held paint show is this function of it and of the
 * intents (`intentKeys`), recomputed when either moves. Intents name changes by
 * `operationKey`, which survives a re-fork, so one projection serves every
 * generation of the draft. Whole commands instead address a generation horizon.
 */
import { type DraftPreviewResponse, operationKey } from "@meridian/contracts/branches";
import { type ChangeCommandRecords, wholeDraftDisposition } from "./branch-command-record";

export type ActivePreview = Extract<DraftPreviewResponse, { status: "active" }>;

/** Which changes the writer has acted on: `hidden` are gone from every surface, `restoring` (a subset) are Discards still drawn as their original. */
export type DraftIntentKeys = {
  readonly hidden: ReadonlySet<string>;
  readonly restoring: ReadonlySet<string>;
};

/** The operation ids in `preview` that these keys name. */
export function idsNamedBy(preview: ActivePreview, keys: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  if (keys.size === 0) return ids;
  for (const op of preview.operations) if (keys.has(operationKey(op))) ids.add(op.operationId);
  return ids;
}

/**
 * The preview without the changes `keys` name (and the hunks only they own).
 * A hunk no operation owns (unclassified) is nobody's to hide: it stays.
 */
export function previewWithoutKeys(
  preview: DraftPreviewResponse,
  keys: ReadonlySet<string>,
): DraftPreviewResponse {
  if (preview.status !== "active") return preview;
  const hidden = idsNamedBy(preview, keys);
  if (hidden.size === 0) return preview;
  const operations = preview.operations.filter((op) => !hidden.has(op.operationId));
  const hunks = preview.hunks.flatMap((hunk) => {
    const operationIds = hunk.operationIds.filter((id) => !hidden.has(id));
    if (hunk.operationIds.length > 0 && operationIds.length === 0) return [];
    if (operationIds.length === hunk.operationIds.length) return [hunk];
    return [
      hunk.kind === "text"
        ? {
            ...hunk,
            operationIds,
            spans: hunk.spans.filter((span) => !hidden.has(span.operationId)),
          }
        : { ...hunk, operationIds },
    ];
  });
  return { ...preview, operations, hunks } satisfies ActivePreview;
}

export type DraftProjection = {
  /** What is left to review: every list, count and focus reads this. */
  preview: DraftPreviewResponse;
  /**
   * The same observation for the manuscript's marks: Discards in flight are
   * still in it, named in `restoring` (operation ids of this observation), so
   * their original text can be drawn in place.
   */
  inline: { preview: DraftPreviewResponse; restoring: ReadonlySet<string> };
};

const NONE: ReadonlySet<string> = new Set();
const hiddenWholeItems = new WeakSet<DraftPreviewResponse>();

/** Whole-item changes can have no operations; an emptied projection still needs its own hide witness. */
export function wholeItemHidden(preview: DraftPreviewResponse): boolean {
  return hiddenWholeItems.has(preview);
}

/** `whole`: a whole-draft command has taken every change of this generation. */
export function projectDraft(
  observed: DraftPreviewResponse,
  intents: DraftIntentKeys,
  whole: boolean,
): DraftProjection {
  if (whole && observed.status === "active") {
    const emptied = { ...observed, operations: [], hunks: [] };
    hiddenWholeItems.add(emptied);
    return { preview: emptied, inline: { preview: emptied, restoring: NONE } };
  }
  const preview = previewWithoutKeys(observed, intents.hidden);
  if (observed.status !== "active") return { preview, inline: { preview, restoring: NONE } };
  const kept = new Set([...intents.hidden].filter((key) => !intents.restoring.has(key)));
  return {
    preview,
    inline: {
      preview: previewWithoutKeys(observed, kept),
      restoring: idsNamedBy(observed, intents.restoring),
    },
  };
}

/** Work files are a projection too: no intent ever removes a cached server row. */
export function projectDraftList<
  T extends { documentId: string; itemKey: string; draftGeneration?: number | null },
>(observed: T[], scope: { projectId: string; workId: string }, records: ChangeCommandRecords): T[] {
  return observed.filter(
    (row) =>
      wholeDraftDisposition(
        records,
        { ...scope, ...row },
        row.draftGeneration ?? undefined,
        observed,
      ) !== "apply",
  );
}
