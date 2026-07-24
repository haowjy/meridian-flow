/** Static contracts for editor content geometry and inline-review CSS. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { editorProseClass } from "./editor-column";

const css = readFileSync(new URL("./editor.css", import.meta.url), "utf8");
const finalModifiersStart = css.indexOf("Conflict is the final visual modifier");

describe("editor content spacing", () => {
  it("keeps half a viewport of typing room inside the ProseMirror content element", () => {
    expect(editorProseClass("docked").split(" ")).toContain("pb-[50vh]");
    expect(editorProseClass("none").split(" ")).toContain("pb-[50vh]");
  });
});

describe("inline review conflict CSS", () => {
  it.each([
    ".meridian-review-merged.meridian-review-conflict",
    ".meridian-review-removed.meridian-review-conflict",
    ".meridian-review-block.meridian-review-added.meridian-review-conflict",
    ".meridian-review-block.meridian-review-writer.meridian-review-conflict",
    ".meridian-review-removed.meridian-review-removed-block.meridian-review-conflict",
  ])("declares the final warning modifier for %s", (selector) => {
    const modifier = css.lastIndexOf(selector);
    expect(modifier).toBeGreaterThan(finalModifiersStart);
    expect(css.slice(modifier, css.indexOf("}", modifier))).toContain(
      "var(--color-review-warning-tint)",
    );
  });
});
