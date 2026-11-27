import { t } from "@lingui/core/macro";
import { THREAD_TITLE_MAX_LENGTH } from "@meridian/contracts/protocol";
import { announce } from "@/client/announcements";
import { useThreadSnapshotCache } from "@/client/query/thread-snapshot-query";
import { useRenameThread } from "@/client/query/useRenameThread";
import { useProjectThreadGroups } from "@/features/project/data/project-thread-groups";
import { TitleEditSlot } from "@/features/project/shell/TitleEditSlot";
import { titleChipClass } from "@/features/project/shell/tab-chip";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { subagentMarkName } from "./subagent/display";
import { ThreadSwitcherPopover } from "./ThreadSwitcherPopover";

type ChatThreadTitleProps = {
  projectId: string;
  threadId: string | null;
  failureClassName?: string;
};

export function ChatThreadTitle(props: ChatThreadTitleProps) {
  if (props.threadId === null)
    return (
      <ThreadSwitcherPopover
        projectId={props.projectId}
        activeThreadId={null}
        title={t`New chat`}
      />
    );
  return <ExistingThreadTitle key={props.threadId} {...props} threadId={props.threadId} />;
}

function ExistingThreadTitle({
  projectId,
  threadId,
  failureClassName,
}: ChatThreadTitleProps & { threadId: string }) {
  const title = useChatTitle(projectId, threadId);
  const rename = useRenameThread(projectId, threadId, (confirmed) => {
    announce(t`Renamed to ${confirmed}`);
  });
  return (
    <TitleEditSlot
      titleKey={`chat:${threadId}`}
      label={t`Rename chat`}
      failure={() => t`Couldn't rename this chat`}
      rename={rename}
      maxLength={THREAD_TITLE_MAX_LENGTH}
      fieldClassName={cn(titleChipClass("quiet"), "pane-title *:mx-1")}
      failureClassName={failureClassName}
    >
      {({ start, triggerRef }) => (
        <ThreadSwitcherPopover
          projectId={projectId}
          activeThreadId={threadId}
          title={title}
          onRename={() => start(title)}
          triggerRef={triggerRef}
        />
      )}
    </TitleEditSlot>
  );
}

export function useChatTitle(projectId: string, threadId: string | null): string {
  const { threadById } = useProjectThreadGroups(projectId);
  const opened = useThreadSnapshotCache(threadId)?.data?.thread;
  return displayThreadTitle(
    (threadId ? threadById.get(threadId)?.title : null) ??
      opened?.title ??
      (opened?.kind === "subagent" ? subagentMarkName(opened.agentName) : null),
  );
}
