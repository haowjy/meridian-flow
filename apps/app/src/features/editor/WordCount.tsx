import { plural } from "@lingui/core/macro";
import { countWords } from "@meridian/agent-edit/diff";
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";

const COUNT_DELAY_MS = 300;

const countAll = (editor: Editor) => {
  const { doc } = editor.state;
  return countWords(doc.textBetween(0, doc.content.size, "\n"));
};

const countSelected = (editor: Editor) => {
  const { from, to } = editor.state.selection;
  return countWords(editor.state.doc.textBetween(from, to, "\n"));
};

export function WordCount({ editor }: { editor: Editor }) {
  const [words, setWords] = useState(() => countAll(editor));
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSelection = () => setSelected(countSelected(editor));
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
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

  if (!words) return null;
  const total = plural(words, { one: "# word", other: "# words" });
  return (
    <span className="tabular-nums">
      {selected ? `${selected.toLocaleString()} / ${total}` : total}
    </span>
  );
}
