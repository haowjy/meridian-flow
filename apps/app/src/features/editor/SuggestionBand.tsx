/**
 * Suggestion mode's review (`VITE_FLOW_SUGGESTIONS=1`): one Live document, viewed as Live or as
 * the Work's draft (Live plus the Work's suggestions). Accept and reject are local edits, so
 * Ctrl+Z takes them back. Discard hides the Work's suggestions in this document; Restore shows them.
 */
import { Trans } from "@lingui/react/macro";
import { type Change, list, type View } from "@meridian/suggestions";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { Button } from "@/components/ui/button";

export const suggestionModeEnabled = import.meta.env.VITE_FLOW_SUGGESTIONS === "1";

/** "This Work's suggestions in this document are discarded", keyed by Work. */
const HIDDEN_ROOT = "suggest_hidden";

export function SuggestionBand({
  editor,
  doc,
  ownerKey,
  accountId,
}: {
  editor: Editor;
  doc: Y.Doc;
  ownerKey: string;
  accountId: string;
}) {
  const hiddenMap = doc.getMap<number>(HIDDEN_ROOT);
  const [hidden, setHidden] = useState(() => new Set(hiddenMap.keys()));
  useEffect(() => {
    const update = () => setHidden(new Set(hiddenMap.keys()));
    hiddenMap.observe(update);
    return () => hiddenMap.unobserve(update);
  }, [hiddenMap]);
  const [showDraft, setShowDraft] = useState(false);
  const view = useMemo<View>(
    () => ({ work: showDraft ? ownerKey : null, hidden }),
    [showDraft, ownerKey, hidden],
  );
  useEffect(() => {
    editor.commands.setSuggestionView(
      view,
      view.work ? { work: view.work, chat: null, turn: null, by: `user:${accountId}` } : null,
    );
  }, [editor, view, accountId]);

  const [changes, setChanges] = useState<Change[]>([]);
  useEffect(() => {
    const draft: View = { work: ownerKey, hidden: new Set() };
    const update = () => setChanges(list(editor.state.doc, draft));
    update();
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor, ownerKey]);
  const discarded = hidden.has(ownerKey);

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
        {discarded ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => hiddenMap.delete(ownerKey)}
          >
            <Trans>Restore</Trans>
          </Button>
        ) : changes.length > 0 ? (
          <>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => editor.commands.acceptSuggestions({ work: ownerKey })}
            >
              <Trans>Apply all</Trans>
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => editor.commands.rejectSuggestions({ work: ownerKey })}
            >
              <Trans>Reject all</Trans>
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => hiddenMap.set(ownerKey, Date.now())}
            >
              <Trans>Discard</Trans>
            </Button>
          </>
        ) : null}
      </div>
      {showDraft && !discarded
        ? changes.map((change) => (
            <div
              key={change.id}
              className="flex items-center gap-1.5"
              data-suggestion-change={change.id}
            >
              <span className="min-w-0 flex-1 truncate">
                {change.deleted ? <span className="sug-del">{change.deleted}</span> : null}
                {change.deleted && change.inserted ? " " : null}
                {change.inserted ? <span className="sug-ins">{change.inserted}</span> : null}
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
