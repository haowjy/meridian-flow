/** Composer-led Project Home and its independent, server-owned return feed. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useState } from "react";
import { useHomeChatFeed } from "@/client/query/useHomeChatFeed";
import { useWorks } from "@/client/query/useWorks";
import { useAnnouncement, useThreadActions } from "@/client/stores";
import { Composer } from "@/components/app/composer";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { resolveCatalogWork } from "../catalog-work-resolution";
import { HomeFeed } from "./HomeFeed";
import { NewThreadComposerToolbar } from "./NewThreadComposerToolbar";
import { useHomeFavoriteMovement } from "./use-home-favorite-movement";
import { useHomeFirstSendAttempt } from "./use-home-first-send-attempt";

export type HomeScreenProps = {
  projectId: string;
  onSelectThread: (threadId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
};

export function HomeScreen({ projectId, onSelectThread, onOpenThread }: HomeScreenProps) {
  const feed = useHomeChatFeed(projectId);
  const worksQuery = useWorks(projectId);
  const actions = useThreadActions();
  const { announce, announceError } = useAnnouncement();
  const movement = useHomeFavoriteMovement();
  const [now, setNow] = useState(Date.now());
  const [agentSlug, setAgentSlug] = useState(DEFAULT_AGENT_SLUG);
  const [chosenWorkId, setChosenWorkId] = useState<string | null>(null);
  const [modePending, setModePending] = useState(false);
  const [finePointer, setFinePointer] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const media = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    if (!media) return;
    const sync = () => setFinePointer(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const firstSend = useHomeFirstSendAttempt({ projectId, actions, onSelectThread });
  const catalogWork = resolveCatalogWork(
    worksQuery.status === "error"
      ? { status: "error" }
      : worksQuery.status === "loading" || worksQuery.status === "disabled"
        ? { status: "loading" }
        : { status: "ready", works: worksQuery.works ?? [] },
  );
  const selectedWork =
    worksQuery.works?.find(({ id }) => id === chosenWorkId) ??
    (catalogWork.status === "ready" ? catalogWork.work : null);
  const handleModePendingChange = useCallback((pending: boolean) => setModePending(pending), []);

  const rowProps = {
    now,
    onOpen: (item: HomeChatItem) => onOpenThread(item.id),
    onFavorite: (item: HomeChatItem, value: boolean, keyboard: boolean) => {
      const optimistic = movement.capture(item.id, keyboard);
      movement.commit(optimistic);
      void feed
        .setFavorite(item.id, value, {
          beforeRollback: () => movement.commit(movement.capture(item.id, keyboard)),
        })
        .then((saved) => {
          if (saved)
            announce(
              value
                ? t`${item.title} moved to Favorite chats`
                : t`${item.title} moved to Recent chats`,
            );
          else announceError(t`Favorite wasn’t saved`);
        });
    },
    onUnread: async (item: HomeChatItem, value: boolean) => {
      const saved = await feed.setUnread(item.id, value);
      if (!saved) announceError(t`Read status wasn’t saved`);
      return saved;
    },
    getCommandState: feed.getCommandState,
  };
  const worksReady = worksQuery.status === "ready" && selectedWork !== null;
  const submitDisabledReason = firstSend.busy
    ? t`Creating chat`
    : modePending
      ? t`Finishing write mode change`
      : worksQuery.status === "loading"
        ? t`Loading Work`
        : !selectedWork
          ? t`Choose a Work`
          : firstSend.attempt
            ? t`Repair your choices, then retry`
            : undefined;
  const submit = (text: string, draftRevision: number) => {
    if (!selectedWork || modePending) return false;
    return firstSend.submit(
      text,
      {
        workId: selectedWork.id,
        agentSlug,
      },
      draftRevision,
    );
  };

  return (
    <div ref={movement.scrollRef} className="app-scroll main-pane">
      <div className="project-screen-column">
        <div className="home-composer-page">
          <section>
            <div className="home-composer-inner">
              <h1 className="home-composer-heading text-headline-section">
                <Trans>What will you write next?</Trans>
              </h1>
              <p className="mt-2 text-body text-muted-foreground">
                <Trans>Start with a scene, a question, or a problem to solve.</Trans>
              </p>
              <div className="mt-4">
                <Composer
                  variant="hero"
                  autoFocus={finePointer}
                  onSubmit={submit}
                  onDraftChange={firstSend.updateDraft}
                  submitDisabled={
                    !worksReady || modePending || firstSend.busy || firstSend.attempt !== null
                  }
                  submitDisabledReason={submitDisabledReason}
                  busy={firstSend.busy}
                  toolbarLeft={
                    <NewThreadComposerToolbar
                      projectId={projectId}
                      work={selectedWork}
                      selectedWorkId={selectedWork?.id ?? null}
                      works={worksQuery.works ?? []}
                      worksStatus={
                        catalogWork.status === "error"
                          ? "error"
                          : catalogWork.status === "loading"
                            ? "loading"
                            : "ready"
                      }
                      agentSlug={agentSlug}
                      disabled={firstSend.contextLocked}
                      onAgentChange={setAgentSlug}
                      onWorkChange={(work) => setChosenWorkId(work.id)}
                      onRetryWorks={worksQuery.refetch}
                      onModePendingChange={handleModePendingChange}
                    />
                  }
                />
                {firstSend.busy ? (
                  <p role="status" aria-live="polite" className="sr-only">
                    <Trans>Creating chat</Trans>
                  </p>
                ) : null}
              </div>
              {worksQuery.status === "error" ? (
                <InlineErrorRow message={t`Work couldn’t load`} onRetry={worksQuery.refetch} />
              ) : null}
              {catalogWork.status === "empty" ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  <Trans>No Work yet.</Trans>
                </p>
              ) : null}
              {firstSend.failure ? (
                <InlineErrorRow
                  message={
                    firstSend.failure === "route"
                      ? t`Chat was created but couldn’t open`
                      : firstSend.failure === "mismatch"
                        ? t`Created chat didn’t match your choices`
                        : t`Chat couldn’t start`
                  }
                  onRetry={
                    firstSend.retryable && selectedWork
                      ? () => {
                          void firstSend.retry({
                            workId: selectedWork.id,
                            agentSlug,
                          });
                        }
                      : undefined
                  }
                />
              ) : null}
            </div>
          </section>
          <HomeFeed feed={feed} rowProps={rowProps} />
        </div>
      </div>
    </div>
  );
}
