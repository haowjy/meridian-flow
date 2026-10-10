/**
 * ContextSidebar — the Chat screen's right rail: the chat's Recent documents,
 * drawn with the left tree's rows and section heads. A click opens the row in
 * the dock's document slot, which covers the rail
 * (it stays mounted underneath) until the document is closed.
 */
import { t } from "@lingui/core/macro";
import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { announceError } from "@/client/stores";
import { fileKindIcon } from "../context/context-file-icon";
import { useOpenChatDocument } from "../context/open-chat-document";
import { DockHeader } from "../dock/DockHeader";
import { DockShell } from "../dock/DockShell";
import { RailEmptyHint, RailErrorRow, RailFileRow } from "./RailSection";

/** Thread-context rail (Chat destination, right edge). */
export type ContextSidebarProps = {
  /** Active thread; when null, the rail shows only its dock header. */
  threadId: string | null;
  /** Active project, which Recent documents open in. */
  projectId: string | null;
  /** Whether the rail's dock is open; a collapsed dock's document editor stands down. */
  visible: boolean;
  onClose: () => void;
};

export function ContextSidebar({ threadId, projectId, visible, onClose }: ContextSidebarProps) {
  const recent = useThreadRecentDocuments(threadId);
  const openDocument = useOpenChatDocument(projectId ?? undefined);
  const openRecent = async (documentId: string) => {
    // On the Chat screen this opens beside the chat; an unreachable document says so.
    const result = await openDocument({ documentId });
    if (result.kind === "unavailable") announceError(t`Couldn’t open this document.`);
  };

  return (
    <aside aria-label={t`Chat context`} className="flex h-full min-h-0 w-full flex-col">
      <DockShell
        projectId={projectId ?? ""}
        placement="dock"
        screen="chat"
        visible={visible}
        renderHeader={(args) => <DockHeader {...args} onClose={onClose} />}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2">
          {/* The header names the panel (Recent), so the list carries no heading of its own. */}
          {recent.status === "loading" ? (
            <RailEmptyHint>{t`Loading recent documents…`}</RailEmptyHint>
          ) : recent.status === "error" ? (
            <RailErrorRow onRetry={recent.refetch} label={t`Couldn't load recent documents.`} />
          ) : recent.documents?.length ? (
            <ul className="pt-1">
              {recent.documents.map((document) => {
                // The tree lists whole file names; the rail names files the same way.
                const fileName = `${document.name}${document.extension ? `.${document.extension.replace(/^\./, "")}` : ""}`;
                return (
                  <li key={document.documentId}>
                    <RailFileRow
                      icon={fileKindIcon(fileName)}
                      name={fileName}
                      title={fileName}
                      onOpen={() => void openRecent(document.documentId)}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </DockShell>
    </aside>
  );
}
