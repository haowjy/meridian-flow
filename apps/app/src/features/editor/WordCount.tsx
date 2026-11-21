import { plural } from "@lingui/core/macro";
import { countWords } from "@meridian/agent-edit/diff";
import { viewDoc, visibleSlice } from "@meridian/suggestions";
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { suggestionView } from "@/core/editor/extensions/suggestion-mode";

/** A full-document walk, so it waits for a pause in typing. */
const COUNT_DELAY_MS = 300;

/**
 * The words the editor's view shows (`@meridian/suggestions`). A newline between blocks, or the
 * last word of one and the first of the next would count as one.
 */
const countAll = (editor: Editor) => {
  const doc = viewDoc(editor.state.doc, suggestionView(editor.state));
  return countWords(doc.textBetween(0, doc.content.size, "\n"));
};

const countSelected = (editor: Editor) => {
  const { selection } = editor.state;
  const { content } = visibleSlice(
    selection.content(),
    selection.$from.parent,
    suggestionView(editor.state),
  );
  return countWords(content.textBetween(0, content.size, "\n"));
};

export function WordCount({ editor }: { editor: Editor }) {
  const [words, setWords] = useState(() => countAll(editor));
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let view = suggestionView(editor.state);
    const onSelection = () => setSelected(countSelected(editor));
    // Switching the view changes the words shown without changing the document.
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      const shown = suggestionView(editor.state);
      if (!transaction.docChanged && shown.draft === view.draft) return;
      view = shown;
      onSelection();
      clearTimeout(timer);
      timer = setTimeout(() => setWords(countAll(editor)), COUNT_DELAY_MS);
    };
    setWords(countAll(editor));
    onSelection();
    editor.on("transaction", onTransaction);
    editor.on("selectionUpdate", onSelection);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", onTransaction);
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor]);

  // Nothing before the room's text arrives: a loading document isn't an empty one.
  if (!words) return null;
  const total = plural(words, { one: "# word", other: "# words" });
  return (
    <span className="tabular-nums">
      {selected ? `${selected.toLocaleString()} / ${total}` : total}
    </span>
  );
}
