import type { DraftId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";

export type WorkDraftDisposal = {
  withDisposal<T>(
    workId: WorkId,
    run: (
      dispose: (
        lineageRootIds: readonly string[],
      ) => Promise<{ releasedObjects: readonly string[]; draftIds: readonly DraftId[] }>,
    ) => Promise<T>,
  ): Promise<T>;
};
