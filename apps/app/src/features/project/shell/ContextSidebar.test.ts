import { FileText, Image as ImageIcon } from "lucide-react";
import { describe, expect, test } from "vitest";

import { pickIconForFileType } from "./ContextSidebar";

/* `documents.file_type` is unconstrained text in the DB, so the rail sees kinds
 * outside `DocumentFileType` (markdown chapters carry `file_type='markdown'`).
 * The picker must always answer — a missing arm used to return `undefined` and
 * take the whole project view down through the row's destructure.
 */
describe("pickIconForFileType", () => {
  test("gives every declared kind its own treatment", () => {
    expect(pickIconForFileType(null)).toEqual({ Icon: FileText, tone: "text-primary" });
    expect(pickIconForFileType("image")).toEqual({
      Icon: ImageIcon,
      tone: "text-status-streaming",
    });
    expect(pickIconForFileType("pdf")).toEqual({ Icon: FileText, tone: "text-destructive" });
    expect(pickIconForFileType("docx")).toEqual({ Icon: FileText, tone: "text-accent" });
    expect(pickIconForFileType("binary")).toEqual({
      Icon: FileText,
      tone: "text-muted-foreground",
    });
  });

  test("falls back to the generic file treatment for kinds outside the union", () => {
    for (const kind of ["markdown", "", "IMAGE", "application/pdf"]) {
      expect(pickIconForFileType(kind)).toEqual({ Icon: FileText, tone: "text-muted-foreground" });
    }
  });
});
