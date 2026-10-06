/**
 * How many times this editor's document has changed, as a number React can
 * depend on, once the changes stop arriving.
 *
 * Document-changing transactions count: the writer's typing, a peer's write,
 * and a rename's rewrite arriving through sync. Selection moves and the link
 * decorations' own answer transactions change nothing in the text, so they do
 * not. The link resolver registers again when this moves, which is what stops
 * an answer outliving the words it answered. Local only: nothing here is
 * persisted or sent.
 *
 * The count moves once per burst, `SETTLE_MS` after the last change. A
 * registration forgets every answer, so one per keystroke would ask the server
 * about every link it could not answer locally on every character typed.
 */

import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";

const SETTLE_MS = 400;

export function useDocumentRevision(editor: Editor | null): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((current) => current + 1), SETTLE_MS);
    };
    editor.on("transaction", onTransaction);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", onTransaction);
    };
  }, [editor]);
  return revision;
}
