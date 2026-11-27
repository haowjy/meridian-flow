import { Extension } from "@tiptap/core";

import { blockTypeInputRule } from "./block-type";

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
    const codeBlock = this.editor.schema.nodes.code_block;
    if (!codeBlock) return [];

    return [
      blockTypeInputRule({
        find: BACKTICK_FENCE,
        type: codeBlock,
        getAttributes: fenceAttributes,
      }),
      blockTypeInputRule({
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
