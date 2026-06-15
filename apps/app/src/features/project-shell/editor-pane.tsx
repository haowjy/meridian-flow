import { useCallback, useEffect, useState } from "react";
import { type ContextDocument, readThreadContext } from "@/client/phase5-api";
import { serverOrigin } from "@/client/server-origin";
import { ChapterEditor } from "@/core/editor/chapter-editor";

type EditorPaneProps = {
  threadId: string;
  uri: string;
};

type DocumentAttribution = {
  originType: string | null;
  actorTurnId: string | null;
  actorUserId: string | null;
};

export function EditorPane({ threadId, uri }: EditorPaneProps) {
  const [document, setDocument] = useState<ContextDocument | null>(null);
  const [loadState, setLoadState] = useState("loading");
  const [syncState, setSyncState] = useState("waiting");
  const [lastAttribution, setLastAttribution] = useState<DocumentAttribution | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshAttribution = useCallback(async () => {
    if (!uri) return;
    try {
      const response = await fetch(
        `${serverOrigin()}/api/threads/${threadId}/context/attribution?uri=${encodeURIComponent(uri)}`,
        { credentials: "include" },
      );
      if (!response.ok) return;
      const body = (await response.json()) as DocumentAttribution;
      setLastAttribution(body);
    } catch {
      // attribution polling is best-effort
    }
  }, [threadId, uri]);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setLoadState("loading");
    setSyncState("waiting");
    setLastAttribution(null);
    setError(null);

    readThreadContext(threadId, uri)
      .then((loaded) => {
        if (cancelled) return;
        setDocument(loaded);
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
    void refreshAttribution();
    const timer = window.setInterval(() => {
      void refreshAttribution();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [document, refreshAttribution]);

  const handleSyncStatus = useCallback(
    (status: string) => {
      setSyncState(status);
      if (status === "subscribed") {
        void refreshAttribution();
      }
    },
    [refreshAttribution],
  );

  return (
    <section className="pane editor-pane" data-testid="editor-pane" aria-label="Chapter editor">
      <header className="pane-header">
        <div>
          <p className="eyebrow">Editor surface</p>
          <h2>manuscript://chapter-1.md</h2>
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

      <div className="editor-host">
        {document ? (
          <ChapterEditor
            documentId={document.documentId}
            onError={setError}
            onSyncStatus={handleSyncStatus}
          />
        ) : null}
      </div>
    </section>
  );
}
