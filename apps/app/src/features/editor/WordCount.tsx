/** The document's word count, and the selection's while one is held, floating over the editor. */
import { plural } from "@lingui/core/macro";
import { countWords } from "@meridian/agent-edit/diff";
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";

/** A full-document walk, so it waits for a pause in typing. */
const COUNT_DELAY_MS = 300;

/** Between blocks, or the last word of one and the first of the next would count as one. */
const countRange = (editor: Editor, from: number, to: number) =>
  countWords(editor.state.doc.textBetween(from, to, "\n"));

const countAll = (editor: Editor) => countRange(editor, 0, editor.state.doc.content.size);

export function WordCount({ editor }: { editor: Editor }) {
  const [words, setWords] = useState(() => countAll(editor));
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setWords(countAll(editor)), COUNT_DELAY_MS);
    };
    const onSelection = () => {
      const { from, to, empty } = editor.state.selection;
      setSelected(empty ? 0 : countRange(editor, from, to));
    };
    setWords(countAll(editor));
    onSelection();
    editor.on("update", onUpdate);
    editor.on("selectionUpdate", onSelection);
    return () => {
      clearTimeout(timer);
      editor.off("update", onUpdate);
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
