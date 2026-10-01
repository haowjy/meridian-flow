/**
 * The document family icons, held once as lucide `IconNode` data: the React
 * components every scheme surface renders (`schemeIcon()`), and the CSS mask
 * images the link chip draws with, both come from here.
 *
 * Masks rather than React icons in the chip because the Editor cannot mount a
 * React icon inside marked prose, and an inline widget there risks caret and
 * selection behaviour. One image per family, in every surface, keeps the chip
 * pixel-identical wherever it appears.
 *
 * The lucide shapes are copied from lucide-react 1.21.0 because lucide-react
 * publishes components, not their node data; `createLucideIcon` is its public
 * way to build one from data, so both consumers read the same paths.
 */

import { createLucideIcon, type IconNode, type LucideIcon } from "lucide-react";
import { LINK_CHIP_ICONS, type LinkChipIcon } from "@/core/editor/links";

/**
 * ScrollQuill, the manuscript's own icon: lucide's `scroll` frame plus its
 * `feather` scaled 0.55 (barb line dropped; it clogs at 14px tree size). The
 * quill overhangs the scroll's top-right, so the page outline is trimmed where
 * the blade sits (lucide's own combo convention, cf. `file-pen`) instead of
 * letting strokes cross.
 */
const SCROLL_QUILL: IconNode = [
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
];

const LIBRARY: IconNode = [
  ["path", { d: "m16 6 4 14", key: "ji33uf" }],
  ["path", { d: "M12 6v14", key: "1n7gus" }],
  ["path", { d: "M8 8v12", key: "1gg7y9" }],
  ["path", { d: "M4 4v16", key: "6qkkli" }],
];

const USER: IconNode = [
  ["path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", key: "975kel" }],
  ["circle", { cx: "12", cy: "7", r: "4", key: "17ys0d" }],
];

const NOTEBOOK_PEN: IconNode = [
  ["path", { d: "M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4", key: "re6nr2" }],
  ["path", { d: "M2 6h4", key: "aawbzj" }],
  ["path", { d: "M2 10h4", key: "l0bgd4" }],
  ["path", { d: "M2 14h4", key: "1gsvsf" }],
  ["path", { d: "M2 18h4", key: "1bu2t1" }],
  [
    "path",
    {
      d: "M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z",
      key: "pqwjuv",
    },
  ],
];

const UPLOAD: IconNode = [
  ["path", { d: "M12 3v12", key: "1x0j5s" }],
  ["path", { d: "m17 8-5-5-5 5", key: "7q97r8" }],
  ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", key: "ih7n3h" }],
];

const FILE_OUTLINE = [
  "path",
  {
    d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    key: "1oefj6",
  },
] satisfies IconNode[number];
const FILE_FOLD = [
  "path",
  { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" },
] satisfies IconNode[number];

const FILE: IconNode = [FILE_OUTLINE, FILE_FOLD];

const FILE_PLUS: IconNode = [
  FILE_OUTLINE,
  FILE_FOLD,
  ["path", { d: "M9 15h6", key: "cctwl0" }],
  ["path", { d: "M12 18v-6", key: "17g6i2" }],
];

/** Scratch and Unfiled share NotebookPen: both are loose writing, told apart by place. */
const FAMILY_ICON_NODES: Record<LinkChipIcon, { name: string; node: IconNode }> = {
  manuscript: { name: "ScrollQuill", node: SCROLL_QUILL },
  kb: { name: "Library", node: LIBRARY },
  user: { name: "User", node: USER },
  unfiled: { name: "NotebookPen", node: NOTEBOOK_PEN },
  scratch: { name: "NotebookPen", node: NOTEBOOK_PEN },
  uploads: { name: "Upload", node: UPLOAD },
  file: { name: "File", node: FILE },
  "file-plus": { name: "FilePlus", node: FILE_PLUS },
};

const components = new Map<IconNode, LucideIcon>();

/** The React icon for a document family, one component per shape. */
export function familyIcon(family: LinkChipIcon): LucideIcon {
  const { name, node } = FAMILY_ICON_NODES[family];
  let component = components.get(node);
  if (!component) {
    component = createLucideIcon(name, node);
    components.set(node, component);
  }
  return component;
}

/**
 * One rule per chip icon, setting `--link-chip-icon` to that family's mask
 * image. The chip stylesheet (`link-chip.css`) draws the icon from the custom
 * property, so the family-to-image map lives only here.
 */
export const LINK_CHIP_ICON_CSS = LINK_CHIP_ICONS.map(
  (icon) =>
    `[data-link-chip-icon="${icon}"]{--link-chip-icon:${maskImage(FAMILY_ICON_NODES[icon].node)}}`,
).join("\n");

/** lucide's own stroke defaults; the mask paints whatever colour the chip gives it. */
function maskImage(node: IconNode): string {
  const shapes = node
    .map(([tag, attributes]) => {
      const drawn = Object.entries(attributes)
        .filter(([name]) => name !== "key")
        .map(([name, value]) => `${name}="${String(value)}"`)
        .join(" ");
      return `<${tag} ${drawn}/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
