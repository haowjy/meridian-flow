/**
 * Smoke test: Phase 4 — Toolbar rename + polish verification
 *
 * Verifies that:
 * 1. ProposalReviewToolbar accepts onKeepAll/onDiscardAll (not onAcceptAll/onRejectAll)
 * 2. useInlineReview returns toolbarProps with the new prop names
 * 3. CSS animation classes exist for pill entrance + resolve flash
 * 4. The reduced-motion media query is present
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Tests directory is frontend/tests/features/documents/ — go up to frontend/src
const srcRoot = resolve(__dirname, "../../../src");

describe("Phase 4: toolbar rename + polish", () => {
  const toolbarSrc = readFileSync(
    resolve(srcRoot, "features/documents/components/ProposalReviewToolbar.tsx"),
    "utf-8",
  );

  it("toolbar uses onKeepAll / onDiscardAll props (not accept/reject)", () => {
    expect(toolbarSrc).toContain("onKeepAll");
    expect(toolbarSrc).toContain("onDiscardAll");
    expect(toolbarSrc).not.toContain("onAcceptAll");
    expect(toolbarSrc).not.toContain("onRejectAll");
  });

  it("toolbar displays 'Keep All' and 'Discard All' labels in JSX", () => {
    // Check that JSX button text uses writer-first language.
    // The JSDoc comment mentions old names for context — only check the
    // actual JSX output (lines after the function declaration).
    const jsxSection = toolbarSrc.slice(
      toolbarSrc.indexOf("return ("),
    );
    expect(jsxSection).toContain("Keep All");
    expect(jsxSection).toContain("Discard All");
    expect(jsxSection).not.toContain("Accept All");
    expect(jsxSection).not.toContain("Reject All");
  });

  it("toolbar has writer-first aria titles", () => {
    expect(toolbarSrc).toContain('title="Keep all changes"');
    expect(toolbarSrc).toContain('title="Discard all changes"');
  });

  it("toolbar pill has entrance animation class", () => {
    expect(toolbarSrc).toContain("cm-review-toolbar-pill");
  });

  const hookSrc = readFileSync(
    resolve(srcRoot, "features/documents/hooks/useInlineReview.ts"),
    "utf-8",
  );

  it("useInlineReview toolbarProps uses onKeepAll / onDiscardAll", () => {
    expect(hookSrc).toContain("onKeepAll");
    expect(hookSrc).toContain("onDiscardAll");
    expect(hookSrc).not.toContain("onAcceptAll");
    expect(hookSrc).not.toContain("onRejectAll");
  });

  it("useInlineReview has resolve feedback trigger", () => {
    expect(hookSrc).toContain("triggerResolveFeedback");
  });

  const globalsCss = readFileSync(resolve(srcRoot, "globals.css"), "utf-8");

  it("globals.css has pill entrance animation", () => {
    expect(globalsCss).toContain(".cm-review-toolbar-pill");
    expect(globalsCss).toContain("cm-review-pill-enter");
  });

  it("globals.css has resolve flash animation", () => {
    expect(globalsCss).toContain(".cm-review-resolve-flash");
    expect(globalsCss).toContain("cm-review-flash");
  });

  it("globals.css respects prefers-reduced-motion", () => {
    expect(globalsCss).toContain("prefers-reduced-motion: reduce");
    // Both pill and flash animations should be disabled
    expect(globalsCss).toMatch(
      /prefers-reduced-motion[\s\S]*cm-review-toolbar-pill[\s\S]*animation:\s*none/,
    );
    expect(globalsCss).toMatch(
      /prefers-reduced-motion[\s\S]*cm-review-resolve-flash[\s\S]*animation:\s*none/,
    );
  });
});
