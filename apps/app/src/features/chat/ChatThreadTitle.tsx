/**
 * The chat's title control: the thread switcher popover, renamed in place
 * through `TitleEditSlot` like Work and project titles. A rename shows at
 * once; a refused one reopens the field with the writer's text and the
 * failure under it.
 *
 * It renders no wrapper of its own: every host already provides a `flex
 * min-w-0 flex-1 items-center` slot the chip sizes against, and the host's
 * header is the failure's positioned ancestor, so the header decides where the
 * failure sits (`failureClassName`).
 */
import { t } from "@lingui/core/macro";
import { THREAD_TITLE_MAX_LENGTH } from "@meridian/contracts/protocol";

import { useRenameThread } from "@/client/query/useRenameThread";
import { announce } from "@/client/stores";
import { useProjectThreadGroups } from "@/features/project/data/project-thread-groups";
import { TitleEditSlot } from "@/features/project/shell/TitleEditSlot";
import { titleChipClass } from "@/features/project/shell/title-chip";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { ThreadSwitcherPopover } from "./ThreadSwitcherPopover";

type ChatThreadTitleProps = {
  projectId: string;
  /** `null` — the empty New chat: the switcher reads "New chat" and has no rename. */
  threadId: string | null;
  /** Trigger presentation — see `ThreadSwitcherPopover`. */
  variant?: "quiet" | "tab";
  /** Where a refused rename sits against the host header's positioned ancestor. */
  failureClassName?: string;
};

export function ChatThreadTitle(props: ChatThreadTitleProps) {
  if (props.threadId === null)
    return (
      <ThreadSwitcherPopover
        projectId={props.projectId}
        activeThreadId={null}
        title={t`New chat`}
        variant={props.variant}
      />
    );
  // Keyed: a refusal that lands after a switch must not reopen on another chat.
  return <ExistingThreadTitle key={props.threadId} {...props} threadId={props.threadId} />;
}

function ExistingThreadTitle({
  projectId,
  threadId,
  variant = "quiet",
  failureClassName,
}: ChatThreadTitleProps & { threadId: string }) {
  const { threadById } = useProjectThreadGroups(projectId);
  const title = displayThreadTitle(threadById.get(threadId)?.title);
  const rename = useRenameThread(projectId, threadId, (confirmed) => {
    announce(t`Renamed to ${confirmed}`);
  });
  return (
    <TitleEditSlot
      titleKey={`chat:${threadId}`}
      label={t`Rename chat`}
      failure={() => t`Couldn’t rename this chat. Try again.`}
      rename={rename}
      maxLength={THREAD_TITLE_MAX_LENGTH}
      // The chip itself, with the switcher label's inset, so the words stay put.
      fieldClassName={cn(titleChipClass(variant), "pane-title *:mx-1")}
      failureClassName={failureClassName}
    >
      {({ start, triggerRef }) => (
        <ThreadSwitcherPopover
          projectId={projectId}
          activeThreadId={threadId}
          title={title}
          onRename={() => start(title)}
          triggerRef={triggerRef}
          variant={variant}
        />
      )}
    </TitleEditSlot>
  );
}
