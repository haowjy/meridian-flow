/** Current-state preview only. The download independently authorizes and counts its content. */
export type ProjectExportOptions = { scratch: boolean; uploads: boolean };
export type ExportOutsideArea = "scratch" | "uploads" | "user" | "deleted";
export type ProjectExportPreview = {
  outsideLinks: { count: number; byArea: Record<ExportOutsideArea, number> };
  pendingDrafts: number;
};
