export type DraftPendingCount = {
  draftId: string;
  projectId: string;
  workId: string | null;
  rootThreadId: string | null;
  documents: number;
  folders: number;
};

export type WorkDraftPendingCounts = {
  countPendingByOwners(input: {
    workIds: readonly string[];
    rootThreadIds: readonly string[];
  }): Promise<readonly DraftPendingCount[]>;
};
