import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_AREA_NAMES,
  EXPORT_MARKER_FILENAME,
  parseExportMarker,
} from "./export-marker.js";

const marker = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    formatVersion: 1,
    areas: DEFAULT_EXPORT_AREA_NAMES,
    works: false,
    excludedLinks: 0,
    ...over,
  });

describe("parseExportMarker", () => {
  it("is the one reader the app and server share: absent, valid or invalid, never a guess", () => {
    const dup = { manuscript: "A", kb: "A", unfiled: "U" };
    const cases: [string, string | undefined, "absent" | "valid" | "invalid"][] = [
      ["no marker", undefined, "absent"],
      ["an export's own marker", marker(), "valid"],
      ["works present", marker({ works: true }), "valid"],
      ["malformed JSON", "{", "invalid"],
      ["unknown version", marker({ formatVersion: 2 }), "invalid"],
      ["works not a boolean", marker({ works: "yes" }), "invalid"],
      [
        "works missing",
        JSON.stringify({ formatVersion: 1, areas: DEFAULT_EXPORT_AREA_NAMES }),
        "invalid",
      ],
      ["duplicate area names", marker({ areas: dup }), "invalid"],
      [
        "path-shaped name",
        marker({ areas: { ...DEFAULT_EXPORT_AREA_NAMES, kb: "a/b" } }),
        "invalid",
      ],
      ["hidden name", marker({ areas: { ...DEFAULT_EXPORT_AREA_NAMES, kb: ".kb" } }), "invalid"],
      [
        "reserved Works name",
        marker({ areas: { ...DEFAULT_EXPORT_AREA_NAMES, kb: "Works" } }),
        "invalid",
      ],
      ["area missing", marker({ areas: { manuscript: "M", kb: "K" } }), "invalid"],
    ];
    for (const [label, text, status] of cases)
      expect(parseExportMarker(text).status, label).toBe(status);
  });

  it("maps folder names back to areas", () => {
    const parsed = parseExportMarker(marker());
    expect(parsed.status === "valid" && parsed.areas.get("Knowledge Base")).toBe("kb");
    expect(EXPORT_MARKER_FILENAME).toBe("meridian-export.json");
  });
});
