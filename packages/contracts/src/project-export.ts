export type ProjectExportOptions = { scratch: boolean; uploads: boolean };
export type ExportOutsideArea = "scratch" | "uploads" | "user" | "deleted";
export type ProjectExportPreview = {
  outsideLinks: { count: number; byArea: Record<ExportOutsideArea, number> };
  pendingDocuments: number;
  refusal?: string;
};
