/**
 * SpawnReportCard — the writer-facing card for a child agent run: who ran, what
 * it reported, and a door into the child chat.
 *
 * Two surfaces share this card: the foreground `spawn` tool result parsed from
 * its output (`spawn-report.ts`), and the background `helper-result` component
 * block. The card is the report; cost and the raw status field are deliberately
 * absent, and the status icon carries running/completed/failed as shape only.
 */
import { t } from "@lingui/core/macro";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import { useOpenChatThread } from "./ChatThreadNavigation";
import type { SpawnReportView } from "./spawn-report";

export function SpawnReportCard({
  agentName,
  title,
  summary,
  status,
  childThreadId,
}: SpawnReportView) {
  const Icon =
    status === "completed" ? CheckCircle2 : status === "failed" ? CircleAlert : LoaderCircle;
  const secondaryTitle = title && title !== agentName ? title : null;

  return (
    <section
      className="my-2 rounded-lg border border-subtle bg-muted px-3 py-2"
      data-spawn-report
      data-spawn-thread={childThreadId ?? undefined}
    >
      <div className="flex items-center gap-2 text-caption font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        <span>{agentName}</span>
        {secondaryTitle ? <span className="min-w-0 truncate">{secondaryTitle}</span> : null}
        {childThreadId ? (
          <span className="ml-auto shrink-0">
            <OpenChildThreadDoor threadId={childThreadId} />
          </span>
        ) : null}
      </div>
      {summary ? (
        <div className="mt-1 text-compact text-foreground">
          <Markdown variant="compact">{summary}</Markdown>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The door out. It reads as a link, never a second full-row button, and outside
 * a project shell it degrades to inert text.
 */
function OpenChildThreadDoor({ threadId }: { threadId: string }) {
  const openThread = useOpenChatThread();
  const label = t`Open`;
  if (!openThread) {
    return <span className="text-caption text-muted-foreground">{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => openThread(threadId)}
      className="focus-ring rounded-sm text-caption text-muted-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text focus-visible:text-jade-text focus-visible:decoration-jade-text"
    >
      {label}
    </button>
  );
}
