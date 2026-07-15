/**
 * ScrollQuill — custom lucide-style icon for the manuscript scheme: a quill
 * over a scroll. Composed from lucide's `scroll` frame plus its `feather`
 * scaled 0.55 (barb line dropped — it clogs at 14px tree size). The quill
 * overhangs the scroll's top-right, so the page outline is trimmed where the
 * blade sits (lucide's own combo convention, cf. `file-pen`) instead of
 * letting strokes cross.
 */
import { createLucideIcon } from "lucide-react";

export const ScrollQuill = createLucideIcon("ScrollQuill", [
  ["path", { d: "M19 17v-5.5", key: "scroll-page-edge" }],
  ["path", { d: "M14.5 3H4", key: "scroll-page-top" }],
  [
    "path",
    {
      d: "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3",
      key: "scroll-roll",
    },
  ],
  [
    "path",
    {
      d: "M16.37 13.15a1.1 1.1 0 0 0 .78-.32l3.38-3.39a3.3 3.3 0 0 0-4.67-4.67L12.47 8.15a1.1 1.1 0 0 0-.32.78v3.67a.55.55 0 0 0 .55.55z",
      key: "quill-blade",
    },
  ],
  ["path", { d: "M18.2 7.1 10.5 14.8", key: "quill-shaft" }],
]);
