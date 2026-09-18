/**
 * SpawnReportCard — the writer-facing card for a child agent run: who ran, what
 * it reported, and a door into the child chat.
 *
 * Canonical surface is the `helper-result` custom block. It is a thin adapter
 * over `ArtifactCard`: the shell owns the chrome, the status maps to a tone, and
 * the title names the agent. Cost and the raw status field stay absent.
 */
import { t } from "@lingui/core/macro";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import { ArtifactCard, type ArtifactCardTone } from "./ArtifactCard";
import { useOpenChatThread } from "./ChatThreadNavigation";

type SpawnReportStatus = "running" | "completed" | "failed";

type SpawnReportCardProps = {
  agentName: string;
  title: string | null;
  summary: string | null;
  status: SpawnReportStatus;
  childThreadId: string | null;
};

const statusPresentation = {
  running: { Icon: LoaderCircle, tone: "running" },
  completed: { Icon: CheckCircle2, tone: "resolved" },
  failed: { Icon: CircleAlert, tone: "failed" },
} satisfies Record<SpawnReportStatus, { Icon: typeof CheckCircle2; tone: ArtifactCardTone }>;

export function SpawnReportCard({
  agentName,
  title,
  summary,
  status,
  childThreadId,
}: SpawnReportCardProps) {
  const { Icon, tone } = statusPresentation[status];
  const hint = title && title !== agentName ? title : undefined;

  return (
    <ArtifactCard
      icon={Icon}
      tone={tone}
      title={agentName}
      hint={hint}
      door={childThreadId ? <OpenChildThreadDoor threadId={childThreadId} /> : undefined}
    >
      {summary ? <Markdown variant="compact">{summary}</Markdown> : null}
    </ArtifactCard>
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
