/** A point-in-time capture of document Yjs state. */
export interface DocumentSnapshot {
  id: string;
  documentId: string;
  snapshotType: "auto" | "named" | "pre_restore";
  name?: string;
  createdByUserId?: string;
  createdAt: Date;
}
