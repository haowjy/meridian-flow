/**
 * ContextSidebar — the Chat screen's right rail: the chat's Recent documents,
 * drawn with the left tree's rows and section heads. A click opens the row in
 * the dock's document slot, which covers the rail
 * (it stays mounted underneath) until the document is closed.
 */
import { t } from "@lingui/core/macro";
import { Clock } from "lucide-react";
import type { ListQueryStatus } from "@/client/query/list-query";
import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { announceError } from "@/client/stores";
import { fileKindIcon } from "../context/context-file-icon";
import { useOpenChatDocument } from "../context/open-chat-document";
import { DockHeader } from "../dock/DockHeader";
import { DockShell } from "../dock/DockShell";
import { CollapsibleRailSection, RailEmptyHint, RailErrorRow, RailFileRow } from "./RailSection";

/** Thread-context rail (Chat destination, right edge). */
export type ContextSidebarProps = {
  /** Active thread; when null, sections render their disabled empty state. */
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
          <DocumentRailSection
            title={t`Recent`}
            icon={Clock}
            status={recent}
            rows={recent.documents}
            onOpen={(document) => void openRecent(document.documentId)}
            messages={{
              disabled: t`Open a chat to see what the AI referenced.`,
              loading: t`Loading recent documents…`,
              empty: t`Documents the AI reads in this chat appear here.`,
              error: t`Couldn't load recent documents.`,
            }}
          />
          <RailEmptyHint>{t`Pick a document from the left or the chat to open it here.`}</RailEmptyHint>
        </div>
      </DockShell>
    </aside>
  );
}

/* Recent document projections share this display shape with catalog rows. */
type RailDocument = {
  documentId: string;
  name: string;
  extension: string;
};

type RailMessages = {
  disabled: string;
  loading: string;
  empty: string;
  error: string;
};

/** One state-machine for the live data rail. */
function DocumentRailSection({
  title,
  icon,
  status,
  rows,
  messages,
  onOpen,
}: {
  title: string;
  icon: typeof Clock;
  status: ListQueryStatus<RailDocument>;
  rows: RailDocument[] | null;
  messages: RailMessages;
  onOpen: (document: RailDocument) => void;
}) {
  return (
    <CollapsibleRailSection title={title} icon={icon} defaultOpen>
      {status.status === "disabled" ? (
        <RailEmptyHint>{messages.disabled}</RailEmptyHint>
      ) : status.status === "loading" ? (
        <RailEmptyHint>{messages.loading}</RailEmptyHint>
      ) : status.status === "error" ? (
        <RailErrorRow onRetry={status.refetch} label={messages.error} />
      ) : status.status === "empty" || rows == null || rows.length === 0 ? (
        <RailEmptyHint>{messages.empty}</RailEmptyHint>
      ) : (
        <ul>
          {rows.map((row) => {
            // The tree lists whole file names; the rail names files the same way.
            const fileName = `${row.name}${row.extension ? `.${row.extension.replace(/^\./, "")}` : ""}`;
            return (
              <li key={row.documentId}>
                <RailFileRow
                  icon={fileKindIcon(fileName)}
                  name={fileName}
                  title={fileName}
                  onOpen={() => onOpen(row)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </CollapsibleRailSection>
  );
}
