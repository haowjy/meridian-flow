/**
 * A door to a source conversation: the chat a fork inherited from, a handoff
 * came from, or a subagent was pointed at with `from`.
 *
 * The name navigates to that chat. A source in the trash cannot be opened, so
 * it reads as plain text and says so. The current title wins over the one
 * frozen at derivation, because the writer knows the chat by its name today.
 */
import { t } from "@lingui/core/macro";
import { useQuery } from "@tanstack/react-query";
import { readThreadTranscript } from "@/client/api/threads-api";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { cn } from "@/lib/utils";
import { useOpenChatThread } from "../ChatThreadNavigation";

export type SourceThreadState = {
  title: string | null;
  /** Null until known. */
  trashed: boolean | null;
};

/**
 * Whether a source chat is live or in the trash, and its current title.
 * `known` is authoritative when the caller already has it (a fork's inherited
 * read reports its owners' trash state). Otherwise a primary in the project's
 * chat list is live; anything else (a subagent, a trashed chat) asks the
 * server with a one-row transcript read, which names the thread's current
 * title and refuses a trashed thread. The server has no lighter thread read.
 */
export function useSourceThread(
  threadId: string,
  fallbackTitle: string | null,
  known?: { trashed: boolean } | null,
): SourceThreadState {
  const projectId = useProjectDocumentNavigationProjectId();
  const { threads } = useProjectThreads(projectId ?? "", { enabled: Boolean(projectId) });
  const listed = threads?.find((thread) => thread.id === threadId) ?? null;
  const probe = useQuery({
    queryKey: ["threads", threadId, "presence"] as const,
    queryFn: async ({ signal }): Promise<{ trashed: boolean; title: string | null }> => {
      try {
        const page = await readThreadTranscript(threadId, { limit: 1 }, signal);
        const self = page.owners.find((owner) => owner.threadId === threadId);
        return { trashed: false, title: self?.title ?? null };
      } catch (error) {
        if (isNotFound(error)) return { trashed: true, title: null };
        throw error;
      }
    },
    enabled: Boolean(threadId) && !listed && threads !== null && (!known || !fallbackTitle),
    staleTime: 30_000,
    retry: false,
  });
  const title = listed?.title ?? probe.data?.title ?? fallbackTitle;
  if (known) return { title, trashed: known.trashed };
  if (listed) return { title, trashed: false };
  return { title, trashed: probe.data?.trashed ?? null };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "status" in error && (error as { status?: number }).status === 404
  );
}

export function SourceChatLink({
  threadId,
  title,
  trashed,
  className,
}: {
  threadId: string;
  title: string | null;
  trashed: boolean | null;
  className?: string;
}) {
  const openThread = useOpenChatThread();
  const name = title?.trim() || t`Untitled chat`;
  if (trashed || !openThread) {
    return (
      <span className={cn("min-w-0 truncate font-medium text-foreground", className)}>
        {trashed ? t`${name} (in the trash)` : name}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        openThread(threadId);
      }}
      aria-label={t`Open source chat ${name}`}
      className={cn(
        "focus-ring min-w-0 truncate rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-foreground",
        className,
      )}
    >
      {name}
    </button>
  );
}
