import { Extension } from "@tiptap/core";

import { blockTypeInputRule } from "./block-type";

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
