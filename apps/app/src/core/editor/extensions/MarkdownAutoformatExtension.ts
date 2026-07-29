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
 * What this extension owns is the two places inheritance leaves the writer
 * worse off: the code fence's info string, and Backspace. The truth table
 * beside it pins the whole surface, inherited rules included, so an upgrade
 * that drops a trigger fails loudly instead of quietly.
 */
import { Extension, textblockTypeInputRule } from "@tiptap/core";

/**
 * A GFM info string runs to the first space; only the fence character itself
 * is excluded. TipTap's own rule captures `[a-z]+`, so ` ```Python `,
 * ` ```c++ ` and ` ```ts-node ` matched nothing at all and left the writer
 * holding literal backticks.
 */
const BACKTICK_FENCE = /^```([^\s`]*)[\s\n]$/;
const TILDE_FENCE = /^~~~([^\s~]*)[\s\n]$/;

/**
 * The language attr is lowercased: it is a lookup key, for highlighting and for
 * the plain-editable `mermaid` block, and GFM info strings are conventionally
 * case-blind, so ` ```Mermaid ` must land on the same block as ` ```mermaid `.
 */
function fenceAttributes(match: RegExpMatchArray) {
  const info = (match[1] ?? "").toLowerCase();
  return { language: info === "" ? null : info };
}

export const MarkdownAutoformatExtension = Extension.create({
  name: "markdownAutoformat",
  // Above the code block extension, whose narrower fence rules yield to these,
  // and above every node extension's Backspace binding.
  priority: 200,

  addInputRules() {
    const codeBlock = this.editor.schema.nodes.code_block;
    if (!codeBlock) return [];

    return [
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
