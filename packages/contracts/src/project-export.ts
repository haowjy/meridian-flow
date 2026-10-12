/** Prepared project-export handoff. The browser owns progress after following downloadUrl. */
export type ProjectExportOptions = { scratch: boolean; uploads: boolean };
export type ExportOutsideArea = "scratch" | "uploads" | "user" | "deleted";
export type ProjectExportStart = {
  downloadUrl: string;
  fileName: string;
  outsideLinks: { count: number; areas: ExportOutsideArea[] };
  pendingDrafts: number;
};
