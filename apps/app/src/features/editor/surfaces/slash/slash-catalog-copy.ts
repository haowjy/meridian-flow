/**
 * The manuscript's slash catalog: every row `/` offers, in writer copy.
 *
 * Lives with the surface that renders these rows rather than with the
 * extension that carries them, because the entries are writer-facing strings
 * and the slash lane's core half holds none (`core/editor/extensions/slash`).
 * The host contributes only what it alone has — a file picker for the image
 * row — and whether to offer a catalog at all.
 */

import { t } from "@lingui/core/macro";

import type { EditorAnchor } from "@/core/editor/anchors";
import { defaultDiagramProvider } from "@/core/editor/diagrams";
import type { SlashCommandCatalog } from "@/core/editor/extensions/slash";

/**
 * The rows, in the order a writer meets them (§5.7): retype this block first,
 * make a new object second.
 *
 * Built per call rather than held as a constant, because the `t` macros must
 * resolve against whatever locale is active when the menu OPENS — a locale
 * switch has to relabel the menu without touching the editor's lifetime.
 */
/** What the writer's verbs call the diagram this row makes. Never localized. */
function diagramName(): string {
  return defaultDiagramProvider().name;
}

export function documentSlashCatalog(
  requestImageUpload: (at: EditorAnchor) => void,
): SlashCommandCatalog {
  return {
    menuLabel: t`Insert block`,
    groupLabels: { text: t`Text`, insert: t`Insert` },
    requestImageUpload,
    items: [
      {
        id: "heading-1",
        group: "text",
        label: t`Heading 1`,
        aliases: [t`title`, t`h1`, t`section`],
      },
      { id: "heading-2", group: "text", label: t`Heading 2`, aliases: [t`h2`, t`subsection`] },
      { id: "heading-3", group: "text", label: t`Heading 3`, aliases: [t`h3`] },
      { id: "bullet-list", group: "text", label: t`Bulleted list`, aliases: [t`list`, t`ul`] },
      { id: "numbered-list", group: "text", label: t`Numbered list`, aliases: [t`ordered`, t`ol`] },
      { id: "quote", group: "text", label: t`Quote`, aliases: [t`blockquote`, t`epigraph`] },
      {
        id: "divider",
        group: "text",
        label: t`Divider`,
        aliases: [t`scene break`, t`hr`, t`rule`],
      },
      {
        id: "table",
        group: "insert",
        label: t`Table`,
        aliases: [t`grid`, t`stat block`, t`status`, t`litrpg`],
        hint: t`3 by 3, header row`,
      },
      {
        id: "diagram",
        group: "insert",
        label: t`Diagram`,
        // The provider's name is the row's hint and one of its aliases, so a
        // writer who thinks in the syntax finds the row: the entry inserts the
        // catalog's default dialect, and the rest are the fence's language menu.
        aliases: [t`flowchart`, t`chart`, diagramName().toLowerCase()],
        hint: diagramName(),
      },
      { id: "code", group: "insert", label: t`Code block`, aliases: [t`fence`, t`codeblock`] },
      {
        id: "image",
        group: "insert",
        label: t`Image`,
        aliases: [t`picture`, t`photo`, t`upload`],
        hint: t`Upload or paste`,
      },
    ],
  };
}
