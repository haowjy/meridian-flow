/** Composer-led Project Home and its independent, server-owned return feed. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem, Thread } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { useEffect, useRef, useState } from "react";
import { createProjectThread } from "@/client/api/projects-api";
import { useHomeChatFeed } from "@/client/query/useHomeChatFeed";
import { useWorks } from "@/client/query/useWorks";
import { useAnnouncement, useThreadActions } from "@/client/stores";
import { Composer } from "@/components/app/composer";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DEFAULT_AGENT_SLUG, threadCreateAgentField } from "@/features/agents";
import { HomeFeed } from "./HomeFeed";
import { NewThreadComposerToolbar } from "./NewThreadComposerToolbar";
import { useHomeFavoriteMovement } from "./use-home-favorite-movement";

export type HomeScreenProps = {
  projectId: string;
  onSelectThread: (threadId: string) => unknown;
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
  const [selectedWork, setSelectedWork] = useState<Work | null>(null);
  const explicitWork = useRef(false);
  const inFlight = useRef(false);
  const lastSubmittedText = useRef("");
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<null | { kind: "create" | "route"; thread?: Thread }>(
    null,
  );
  const [finePointer, setFinePointer] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const media = matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setFinePointer(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (explicitWork.current) {
      if (selectedWork && !worksQuery.works?.some(({ id }) => id === selectedWork.id))
        setSelectedWork(null);
      return;
    }
    setSelectedWork(worksQuery.currentWork);
  }, [selectedWork, worksQuery.currentWork, worksQuery.works]);

  async function routeCreatedThread(thread: Thread) {
    try {
      await onSelectThread(thread.id);
      actions.armFirstSend(thread.id);
      setFailure(null);
      return true;
    } catch {
      setFailure({ kind: "route", thread });
      return false;
    }
  }

  async function submit(text: string) {
    if (inFlight.current || !selectedWork) return false;
    if (failure?.kind === "route" && failure.thread) return routeCreatedThread(failure.thread);
    inFlight.current = true;
    lastSubmittedText.current = text;
    setCreating(true);
    setFailure(null);
    try {
      const thread = await createProjectThread(projectId, {
        id: crypto.randomUUID(),
        workId: selectedWork.id,
        ...threadCreateAgentField(agentSlug),
      });
      actions.ensureThread(thread);
      const optimistic = actions.appendUserTurn(thread.id, text);
      actions.stageFirstSend({ threadId: thread.id, text, optimisticUserTurnId: optimistic.id });
      return await routeCreatedThread(thread);
    } catch {
      setFailure({ kind: "create" });
      return false;
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }

  const cardProps = {
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

  return (
    <div ref={movement.scrollRef} className="app-scroll">
      <div className="project-screen-column home-composer-page">
        <section className="home-composer-entry">
          <div className="home-composer-inner">
            <h1 className="text-headline-hero">
              <Trans>What will you write next?</Trans>
            </h1>
            <p className="mt-2 text-body text-muted-foreground">
              <Trans>Start with a scene, a question, or a problem to solve.</Trans>
            </p>
            <div className="mt-4 @2xl/project-home:mt-6">
              <Composer
                variant="hero"
                autoFocus={finePointer}
                onSubmit={submit}
                submitDisabled={!worksReady || creating}
                toolbarLeft={
                  selectedWork ? (
                    <NewThreadComposerToolbar
                      projectId={projectId}
                      work={selectedWork}
                      works={worksQuery.works ?? []}
                      worksStatus={
                        worksQuery.status === "error"
                          ? "error"
                          : worksQuery.status === "ready"
                            ? "ready"
                            : "loading"
                      }
                      agentSlug={agentSlug}
                      disabled={creating}
                      onAgentChange={setAgentSlug}
                      onWorkChange={(work) => {
                        explicitWork.current = true;
                        setSelectedWork(work);
                      }}
                      onRetryWorks={worksQuery.refetch}
                    />
                  ) : undefined
                }
              />
            </div>
            {worksQuery.status === "error" ? (
              <InlineErrorRow message={t`Work couldn’t load`} onRetry={worksQuery.refetch} />
            ) : null}
            {failure ? (
              <InlineErrorRow
                message={
                  failure.kind === "create"
                    ? t`Chat couldn’t start`
                    : t`Chat was created but couldn’t open`
                }
                onRetry={() => {
                  if (failure.thread) void routeCreatedThread(failure.thread);
                  else if (lastSubmittedText.current) void submit(lastSubmittedText.current);
                }}
              />
            ) : null}
          </div>
        </section>
        <HomeFeed feed={feed} cardProps={cardProps} />
      </div>
    </div>
  );
}
