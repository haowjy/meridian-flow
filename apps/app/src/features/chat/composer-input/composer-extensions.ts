/**
 * The composer's schema: a message box, not the editor.
 *
 * `doc > paragraph+`; inline content is text, a hard break, and the reference
 * token. No marks, no headings, no lists — everything the manuscript's
 * StarterKit would add is switched off, because a chat message is prose the
 * wire carries as a plain string and structure here would be structure
 * serialization throws away. Paste strips to plain text for the same reason
 * (`plainTextPaste` below): the schema would drop the formatting anyway, and
 * doing it explicitly keeps a pasted chapter from arriving as surprise
 * paragraph soup shaped by whatever HTML the source app emitted.
 *
 * The hard break is `MeridianHardBreak` (named `hard_break`), not TipTap's
 * default, so the shared trigger envelope's word-boundary rule — which knows a
 * line break starts a word — reads the composer exactly as it reads the
 * manuscript.
 */

import { type AnyExtension, Extension } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";

import { MeridianHardBreak } from "@/core/editor/extensions/meridian-extensions";

import {
  ComposerReferenceExtension,
  type ComposerReferenceOptions,
} from "./composer-reference-suggestion";
import { serializeComposerFragment } from "./composer-serialization";
import { ReferenceTokenNode } from "./reference-token";

export type ComposerExtensionsOptions = ComposerReferenceOptions & {
  /** Read per paint, so the rotating pool and the streaming flip stay live. */
  placeholder: () => string;
};

export function createComposerExtensions({
  catalog,
  placeholder,
}: ComposerExtensionsOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      // The message box keeps document, paragraph, text, and undo/redo; with
      // paragraph as the only block, `block+` IS `paragraph+`.
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      link: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      strike: false,
      trailingNode: false,
      underline: false,
      // Replaced by MeridianHardBreak so the node keeps the manuscript's name.
      hardBreak: false,
    }),
    MeridianHardBreak,
    ReferenceTokenNode,
    ComposerReferenceExtension.configure({ catalog }),
    Placeholder.configure({ placeholder: () => placeholder() }),
    ComposerClipboardExtension,
  ];
}

/**
 * Paste is plain text; copy is the serialization. Both directions speak the
 * same string the wire does, so a token copied out of the composer travels as
 * its spelling — and pasted back it stays plain text, because hand-arrived
 * text never attaches (only picks create tokens; ruled).
 */
const ComposerClipboardExtension = Extension.create({
  name: "composerClipboard",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          clipboardTextSerializer: (slice) => serializeComposerFragment(slice.content),
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData("text/plain");
            if (!text) return false;
            const { schema, tr } = view.state;
            const paragraphs = text
              .split(/\r\n?|\n/)
              .map((line) =>
                schema.nodes.paragraph.createChecked(null, line ? [schema.text(line)] : undefined),
              );
            // Open on both ends so a single-line paste lands inside the
            // sentence instead of splitting it.
            view.dispatch(
              tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1)).scrollIntoView(),
            );
            return true;
          },
        },
      }),
    ];
  },
});
