/**
 * Markdown that transforms as the writer types.
 *
 * Most of the surface is inherited rather than written: TipTap's node and mark
 * extensions already ship GFM input rules, its engine already refuses to run
 * them inside anything whose spec is `code`, and because the Meridian wrappers
 * only rename types those rules resolve the server-parity names (`strong`,
 * `em`, `bullet_list`, `code_block`). Reimplementing them here would be a
 * second set of rules competing for the same keystrokes. Inherited unchanged:
 * `# `…`###### ` headings, `**b**` / `*i*` / `~~s~~` / `` `c` `` marks, `> `
 * blockquote, `- ` / `* ` / `+ ` bullets, `1. ` ordered lists, `---` divider,
 * and completion on Enter as well as on space.
 *
 * What this extension owns is the remaining autoformat behavior: completed
 * wikilinks, the code fence's info string, and Backspace. The truth table
 * beside it pins the whole surface, inherited rules included, so an upgrade
 * that drops a trigger fails loudly instead of quietly.
 */
import { markdownCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { Extension, InputRule, textblockTypeInputRule } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { classifyLinkTarget } from "../links/link-target";
import { autoClosedRunLength } from "./auto-pair";

const WIKILINK_CONVERSION = "wikilinkAutoformat";

/**
 * A fence is an opening run of at least three fence characters and an info
 * string running to the first space. Capturing the run separately from the
 * info token is what lets the two differ: GFM forbids backticks inside a
 * backtick fence's info string and forbids nothing inside a tilde fence's, so
 * ` ~~~aa~bb ` is a language and ` ~~~~ ` is a longer fence with none. The run
 * is greedy for the same reason GFM's own parser is.
 *
 * TipTap's rule captures `[a-z]+` and no run at all, so ` ```Python `,
 * ` ```c++ ` and ` ```ts-node ` matched nothing and left the writer holding
 * literal backticks.
 */
const BACKTICK_FENCE = /^(`{3,})([^\s`]*)[\s\n]$/;
const TILDE_FENCE = /^(~{3,})([^\s]*)[\s\n]$/;

/**
 * The language attr is lowercased: it is a lookup key, for highlighting and for
 * the plain-editable `mermaid` block, and GFM info strings are conventionally
 * case-blind, so ` ```Mermaid ` must land on the same block as ` ```mermaid `.
 */
function fenceAttributes(match: RegExpMatchArray) {
  const info = (match[2] ?? "").toLowerCase();
  return { language: info === "" ? null : info };
}

export const MarkdownAutoformatExtension = Extension.create({
  name: "markdownAutoformat",
  // Above the code block extension, whose narrower fence rules yield to these,
  // and above every node extension's Backspace binding.
  priority: 200,

  addInputRules() {
    const codec = markdownCodec({
      schema: this.editor.schema,
      assetPathResolver: unresolvedAssetPathResolver,
    });
    const wikilink = new InputRule({
      // The codec owns grammar and escaping. Recognition does not query a catalog:
      // a destination that does not exist yet is still a valid link.
      find: (text) => {
        if (!text.endsWith("]]")) return null;
        for (let index = text.indexOf("[["); index !== -1; index = text.indexOf("[[", index + 2)) {
          const prefix = text.slice(0, index);
          if (prefix.endsWith("!") || (prefix.match(/\\+$/)?.[0].length ?? 0) % 2) continue;
          const source = text.slice(index);
          const blocks = codec.parse(source).blocks;
          const block = blocks.length === 1 ? blocks[0] : undefined;
          const node = block?.childCount === 1 ? block.firstChild : null;
          const link = node?.marks.find((mark) => mark.type.name === "link");
          if (block?.type.name !== "paragraph" || !node?.isText || !link) continue;
          if (!classifyLinkTarget(link.attrs.href)) continue;
          return { index, text: source, data: { node } };
        }
        return null;
      },
      // Auto-pairing may already have written the final bracket. The generic
      // input-rule Backspace replay would insert that bracket a second time.
      // Use normal document Undo, isolated from the preceding typing instead.
      undoable: false,
      handler: ({ state, range, match }) => {
        // Input rules flatten inline leaves to synthetic text whose length is
        // not a document offset. Only a real, same-block text range is eligible.
        if (range.from < 0 || range.from < state.doc.resolve(range.to).start()) return null;
        let protectedContent = false;
        state.doc.nodesBetween(range.from, range.to, (node) => {
          if (
            (node.isInline && !node.isText) ||
            node.marks.some((mark) => mark.type.name === "link" || mark.type.spec.code)
          ) {
            protectedContent = true;
          }
        });
        if (protectedContent) return null;
        const node = match.data?.node as PMNode;
        let to = range.to;
        if (autoClosedRunLength(state, to) > 0 && state.doc.textBetween(to, to + 1) === "]") to++;
        const marks = state.selection.$from.marks().filter((mark) => mark.type.name !== "link");
        yUndoPluginKey.getState(this.editor.state)?.undoManager.stopCapturing();
        const tr = closeHistory(state.tr);
        tr.replaceWith(range.from, to, node.mark([...marks, ...node.marks]));
        tr.removeStoredMark(state.schema.marks.link);
        tr.setMeta(WIKILINK_CONVERSION, true);
      },
    });
    const codeBlock = this.editor.schema.nodes.code_block;
    if (!codeBlock) return [wikilink];

    return [
      wikilink,
      textblockTypeInputRule({
        find: BACKTICK_FENCE,
        type: codeBlock,
        getAttributes: fenceAttributes,
      }),
      textblockTypeInputRule({
        find: TILDE_FENCE,
        type: codeBlock,
        getAttributes: fenceAttributes,
      }),
    ];
  },

  onTransaction({ transaction, editor }) {
    if (!transaction.getMeta(WIKILINK_CONVERSION)) return;
    // The binding has recorded the conversion now. Close its other boundary so
    // subsequent prose is a separate Undo item, in both collaborative and PM history.
    yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
    editor.view.dispatch(closeHistory(editor.state.tr));
  },

  addKeyboardShortcuts() {
    return {
      /**
       * Backspace undoes the transform the last keystroke made — the writer's
       * escape hatch, asserted here rather than inherited. TipTap reaches for
       * `undoInputRule` first as well, but from the core keymap, which sits
       * below every node extension's: CodeBlock's "delete the empty block"
       * binding got to a just-opened fence first and swallowed the ``` that
       * opened it.
       *
       * Refusing when there is nothing to undo leaves the rest of the Backspace
       * chain untouched.
       */
      Backspace: () => {
        if (!this.editor.can().undoInputRule()) return false;

        return this.editor
          .chain()
          .undoInputRule()
          .command(({ tr }) => {
            // The engine restores whatever character triggered the rule, and a
            // rule completed by Enter was triggered by a literal newline: not
            // a character the writer typed, and invisible once it is in prose.
            const { $from, empty } = tr.selection;
            if (!empty || $from.parentOffset === 0 || $from.parent.type.spec.code) return true;
            if (tr.doc.textBetween($from.pos - 1, $from.pos) === "\n") {
              tr.delete($from.pos - 1, $from.pos);
            }
            return true;
          })
          .run();
      },
    };
  },
});
