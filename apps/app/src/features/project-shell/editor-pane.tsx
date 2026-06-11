import { useEffect, useState } from "react";
import { type ContextDocument, readThreadContext } from "@/client/phase5-api";
import { type DocumentMarkdownUpdate, subscribeDocumentUpdates } from "@/client/yjs-client";

type EditorPaneProps = {
  threadId: string;
  uri: string;
};

export function EditorPane({ threadId, uri }: EditorPaneProps) {
  const [document, setDocument] = useState<ContextDocument | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [loadState, setLoadState] = useState("loading");
  const [syncState, setSyncState] = useState("waiting");
  const [lastAttribution, setLastAttribution] = useState<DocumentMarkdownUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setMarkdown("");
    setLoadState("loading");
    setSyncState("waiting");
    setLastAttribution(null);
    setError(null);

    readThreadContext(threadId, uri)
      .then((loaded) => {
        if (cancelled) return;
        setDocument(loaded);
        setMarkdown(loaded.markdown);
        setLoadState("loaded");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [threadId, uri]);

  useEffect(() => {
    if (!document) return undefined;
    let active = true;
    const unsubscribe = subscribeDocumentUpdates(document.documentId, {
      onStatus: (nextStatus) => {
        if (active) setSyncState(nextStatus);
      },
      onError: (nextError) => {
        if (active) setError(nextError);
      },
      onUpdate: (update) => {
        if (!active) return;
        setMarkdown(update.markdown);
        setLastAttribution(update);
      },
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [document]);

  return (
    <section className="pane editor-pane" data-testid="editor-pane" aria-label="Chapter editor">
      <header className="pane-header">
        <div>
          <p className="eyebrow">Editor surface</p>
          <h2>work://manuscript/chapter-1.md</h2>
        </div>
        <div className="debug-stack">
          <span className="debug-pill" data-testid="context-load-status">
            Context {loadState}
          </span>
          <span className="debug-pill" data-testid="yjs-status">
            Yjs {syncState}
          </span>
          <span
            className="debug-pill"
            data-actor-turn-id={lastAttribution?.actorTurnId ?? ""}
            data-actor-user-id={lastAttribution?.actorUserId ?? ""}
            data-origin-type={lastAttribution?.originType ?? ""}
            data-testid="editor-attribution"
          >
            Last update {lastAttribution?.originType ?? "none"}
            {lastAttribution?.actorTurnId ? ` ${lastAttribution.actorTurnId}` : ""}
          </span>
        </div>
      </header>

      {error ? (
        <p className="error" data-testid="editor-error">
          {error}
        </p>
      ) : null}

      <textarea
        aria-label="Chapter markdown"
        className="editor-textarea"
        data-document-id={document?.documentId ?? ""}
        data-testid="chapter-editor"
        onChange={(event) => setMarkdown(event.currentTarget.value)}
        spellCheck="true"
        value={markdown}
      />
    </section>
  );
}
