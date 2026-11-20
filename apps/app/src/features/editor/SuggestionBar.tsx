/** Suggestion mode's review: switch between Live and the Work's view, and settle its changes. */
import { Trans } from "@lingui/react/macro";
import { listSuggestions, type SuggestionChange, settleSuggestions } from "@meridian/suggestions";
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { showSuggestionView, suggestionViewOf } from "@/core/editor/extensions/suggest-changes";

export const SUGGESTIONS_ENABLED = import.meta.env.VITE_FLOW_SUGGESTIONS === "1";

type BarState = {
  suggesting: boolean;
  changes: SuggestionChange[];
  atCaret: SuggestionChange | null;
};

function read(editor: Editor, work: string): BarState {
  const changes = listSuggestions(editor.state.doc, work);
  const { from } = editor.state.selection;
  return {
    suggesting: suggestionViewOf(editor).suggester !== null,
    changes,
    atCaret: changes.find((change) => change.from <= from && from <= change.to) ?? null,
  };
}

export function SuggestionBar({
  editor,
  work,
  accountId,
}: {
  editor: Editor;
  /** The Work's owner key (`work:<id>`), the same key the server marks the AI's suggestions with. */
  work: string;
  accountId: string;
}) {
  const [state, setState] = useState(() => read(editor, work));
  useEffect(() => {
    const update = () => setState(read(editor, work));
    update();
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor, work]);

  const settle = (how: "accept" | "reject", id?: string) => {
    const tr = settleSuggestions(editor.state, id ? { work, id } : { work }, how);
    if (tr) editor.view.dispatch(tr);
    // The press is the editor's: Ctrl+Z right after it undoes it.
    editor.view.focus();
  };
  const toggle = () =>
    showSuggestionView(editor, {
      suggester: state.suggesting
        ? null
        : { work, chat: null, turn: null, by: `user:${accountId}` },
    });
  const count = state.changes.length;

  return (
    <div
      data-suggestion-bar
      className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Button size="meta" variant={state.suggesting ? "secondary" : "quiet"} onClick={toggle}>
        {state.suggesting ? <Trans>Suggesting</Trans> : <Trans>Live</Trans>}
      </Button>
      {state.suggesting ? (
        <>
          <span>
            <Trans>{count} changes</Trans>
          </span>
          {state.atCaret ? (
            <>
              <Button
                size="meta"
                variant="quiet"
                onClick={() => settle("accept", state.atCaret?.id)}
              >
                <Trans>Accept</Trans>
              </Button>
              <Button
                size="meta"
                variant="quiet"
                onClick={() => settle("reject", state.atCaret?.id)}
              >
                <Trans>Reject</Trans>
              </Button>
            </>
          ) : null}
          {count > 0 ? (
            <span className="ml-auto flex gap-1">
              <Button size="meta" variant="quiet" onClick={() => settle("accept")}>
                <Trans>Accept all</Trans>
              </Button>
              <Button size="meta" variant="quiet" onClick={() => settle("reject")}>
                <Trans>Reject all</Trans>
              </Button>
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
