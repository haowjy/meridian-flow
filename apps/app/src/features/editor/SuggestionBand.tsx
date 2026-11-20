/**
 * Suggestion mode's review (`VITE_FLOW_SUGGESTIONS=1`): one Live document, viewed as Live or as
 * the Work's draft (Live plus the Work's suggestions). Apply and Reject on one change are local
 * edits, so Ctrl+Z takes them back. Apply all and Discard press the document: one server command
 * over its text and its tree change, taken back by Undo.
 */
import { Trans } from "@lingui/react/macro";
import { type Change, list, type View } from "@meridian/suggestions";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { useCommand, useCommandDriver } from "@/client/commands/driver-context";
import { PRESS_KIND, submitPress, submitPressUndo } from "@/client/query/press-commands";
import { Button } from "@/components/ui/button";

export function SuggestionBand({
  editor,
  ownerKey,
  accountId,
  projectId,
  documentId,
  document,
}: {
  editor: Editor;
  ownerKey: string;
  accountId: string;
  projectId: string;
  documentId: string;
  /** The open document: a press waits until the server holds what this tab has typed. */
  document: Y.Doc;
}) {
  const driver = useCommandDriver();
  /** The band's last press or Undo, by its record id; one at a time, so Undo names that press. */
  const [lastId, setLastId] = useState<string | null>(null);
  const last = useCommand(lastId);
  const busy = last?.state === "sending";
  const undoable = last?.kind === PRESS_KIND && last.state === "done";
  const press = async (verdict: "apply" | "discard") => {
    if (!driver) return;
    const vector = btoa(String.fromCharCode(...Y.encodeStateVector(document)));
    const record = await submitPress(driver, {
      projectId,
      owner: ownerKey,
      verdict,
      items: [{ node: documentId }],
      seen: [{ documentId, vector }],
    });
    if (record) setLastId(record.id);
  };
  const undo = async () => {
    if (!driver || !last) return;
    const record = await submitPressUndo(driver, ownerKey, {
      projectId,
      pressCommandId: last.sendId,
    });
    if (record) setLastId(record.id);
  };
  const [showDraft, setShowDraft] = useState(false);
  const view = useMemo<View>(() => ({ work: showDraft ? ownerKey : null }), [showDraft, ownerKey]);
  useEffect(() => {
    editor.commands.setSuggestionView(
      view,
      view.work ? { chat: null, turn: null, by: `user:${accountId}` } : null,
    );
  }, [editor, view, accountId]);

  const [changes, setChanges] = useState<Change[]>([]);
  useEffect(() => {
    const draft: View = { work: ownerKey };
    const update = () => setChanges(list(editor.state.doc, draft));
    update();
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor, ownerKey]);

  return (
    <div
      className="flex flex-col gap-1 border-border-subtle border-b px-3 py-1.5 text-xs"
      data-suggestion-band
    >
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          variant={showDraft ? "ghost" : "secondary"}
          onClick={() => setShowDraft(false)}
        >
          <Trans>Live</Trans>
        </Button>
        <Button
          type="button"
          size="xs"
          variant={showDraft ? "secondary" : "ghost"}
          onClick={() => setShowDraft(true)}
        >
          <Trans>Draft ({changes.length})</Trans>
        </Button>
        <span className="flex-1" />
        {undoable ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => void undo()}>
            <Trans>Undo</Trans>
          </Button>
        ) : null}
        {changes.length > 0 ? (
          <>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void press("apply")}
            >
              <Trans>Apply all</Trans>
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void press("discard")}
            >
              <Trans>Discard</Trans>
            </Button>
          </>
        ) : null}
      </div>
      {showDraft
        ? changes.map((change) => (
            <div
              key={change.id}
              className="flex items-center gap-1.5"
              data-suggestion-change={change.id}
            >
              <span className="min-w-0 flex-1 truncate">
                {change.attrs ? <AttrsLabel attrs={change.attrs} /> : null}
                {change.deleted ? <span className="sug-del">{breaks(change.deleted)}</span> : null}
                {change.deleted && change.inserted ? " " : null}
                {change.inserted ? (
                  <span className="sug-ins">{breaks(change.inserted)}</span>
                ) : null}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => editor.commands.acceptSuggestions({ id: change.id })}
              >
                <Trans>Apply</Trans>
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => editor.commands.rejectSuggestions({ id: change.id })}
              >
                <Trans>Reject</Trans>
              </Button>
            </div>
          ))
        : null}
    </div>
  );
}

/** A paragraph break shows as ¶, so a change that only adds or removes one is not blank. */
function breaks(text: string): string {
  return text.replaceAll("\n", "¶");
}

function AttrsLabel({ attrs }: { attrs: Record<string, unknown> }) {
  if (!("level" in attrs)) return <Trans>Block format</Trans>;
  return attrs.level ? <Trans>Heading {String(attrs.level)}</Trans> : <Trans>Body text</Trans>;
}
