/** A point-in-time capture of document Yjs state. */
export interface DocumentSnapshot {
  id: string;
  documentId: string;
  snapshotType: "auto" | "auto_human" | "auto_ai_accept" | "named" | "pre_restore";
  name?: string;
  createdByUserId?: string;
  createdAt: Date;
}
