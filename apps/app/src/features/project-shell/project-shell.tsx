import { ChatPane } from "./chat-pane";
import { EditorPane } from "./editor-pane";

type ProjectShellProps = {
  projectId: string;
  workId: string;
  threadId: string;
  documentId: string;
  uri: string;
};

export function ProjectShell({ projectId, workId, threadId, documentId, uri }: ProjectShellProps) {
  return (
    <main className="project-shell" data-testid="project-shell">
      <header className="shell-topbar">
        <div>
          <p className="eyebrow">Meridian v3 Phase 5</p>
          <h1>Project workbench</h1>
        </div>
        <dl className="debug-grid" aria-label="Phase 5 bootstrap identifiers">
          <div>
            <dt>Project</dt>
            <dd data-testid="project-id">{projectId}</dd>
          </div>
          <div>
            <dt>Work</dt>
            <dd data-testid="work-id">{workId}</dd>
          </div>
          <div>
            <dt>Thread</dt>
            <dd data-testid="thread-id">{threadId}</dd>
          </div>
          <div>
            <dt>Document</dt>
            <dd data-testid="document-id">{documentId}</dd>
          </div>
        </dl>
      </header>
      <div className="workbench-grid">
        <ChatPane threadId={threadId} />
        <EditorPane threadId={threadId} uri={uri} />
      </div>
    </main>
  );
}
