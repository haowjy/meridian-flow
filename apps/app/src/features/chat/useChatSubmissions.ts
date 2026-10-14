/** Mount binding: cancellation, external wakes, and keyed accessibility presentation. */
import { t } from "@lingui/core/macro";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  getChatSubmissionAccountId,
  getChatSubmissionEpoch,
  subscribeChatSubmissions,
} from "@/client/chat-submissions";
import {
  cleanDeletedChat,
  registerDeletedChatSurface,
} from "@/client/chat-submissions/deleted-chat";
import {
  ChatSubmissionOwner,
  type JournalSwitch,
  onSwitchAnswered,
  type SwitchAnswer,
} from "@/client/chat-submissions/owner";
import type { SwitchFrontier } from "@/client/chat-submissions/store";
import { threadAvailability } from "@/client/chat-submissions/thread-availability";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announceError, clearAnnouncement, type ThreadStoreActions } from "@/client/stores";
import type { ComposerSubmitEnvelope } from "@/components/app/composer";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { controlStatusCopy } from "./thread-controls/control-copy";

const NO_SWITCHES: readonly JournalSwitch[] = [];

export function useChatSubmissions(
  threadId: string,
  projectId: string,
  accountId: string,
  controller: ThreadRunController,
  actions: ThreadStoreActions,
  focusComposer: () => void,
  dissolveChat: () => void,
  deletion?: { visible: boolean; title: string | null; leave(moved: boolean): void },
) {
  const queryClient = useQueryClient();
  const transport = useOptionalThreadTransport();
  const accountSignal = useOptionalAccountEpochSignal();
  const driver = useRef<ChatSubmissionOwner | null>(null);
  const [, render] = useReducer((value: number) => value + 1, 0);
  const latest = useRef({ actions, focusComposer, dissolveChat, deletion });
  latest.current = { actions, focusComposer, dissolveChat, deletion };

  useEffect(() => {
    const lifetime = new AbortController();
    const epoch = getChatSubmissionEpoch();
    const signal = accountSignal
      ? AbortSignal.any([accountSignal, lifetime.signal])
      : lifetime.signal;
    const current = () =>
      !signal.aborted &&
      getChatSubmissionAccountId() === accountId &&
      getChatSubmissionEpoch() === epoch;
    const announcementKeys = new Set<string>();
    const clearRowAnnouncement = (recordId: string) => {
      const key = `${accountId}:${recordId}`;
      clearAnnouncement(key);
      announcementKeys.delete(key);
    };
    const owner = new ChatSubmissionOwner({
      accountId,
      threadId,
      projectId,
      signal,
      current,
      controller,
      queryClient,
      actions: latest.current.actions,
      changed: render,
      failed: (recordId) => {
        const key = `${accountId}:${recordId}`;
        announcementKeys.add(key);
        announceError(t`Couldn't send your message.`, { key });
      },
      failedSwitch: (entry) => {
        if (!entry.control) return;
        const key = `${accountId}:${entry.recordId}`;
        announcementKeys.add(key);
        announceError(controlStatusCopy(entry.control, "failed"), { key });
      },
      clear: clearRowAnnouncement,
      focusComposer: () => latest.current.focusComposer(),
      dissolveChat: () => latest.current.dissolveChat(),
    });
    const unregisterDeletion = registerDeletedChatSurface(accountId, threadId, {
      visible: () => latest.current.deletion?.visible ?? false,
      title: () => latest.current.deletion?.title ?? null,
      recordIds: owner.shownRecordIds,
      leave: (moved) => latest.current.deletion?.leave(moved),
    });
    driver.current = owner;
    owner.rebuild();
    const availability = threadAvailability(
      queryClient.getQueryState(threadQueryKeys.snapshot(threadId))?.error,
      accountId,
    );
    if (availability === "deleted" || availability === "project-deleted")
      void cleanDeletedChat(accountId, threadId, projectId, availability).catch(reportError);
    const wake = () => {
      if (current()) void owner.driver.drive(threadId);
    };
    wake();
    const unsubscribe = subscribeChatSubmissions(owner.rebuild);
    const storage = () => {
      owner.rebuild();
      wake();
    };
    window.addEventListener("storage", storage);
    window.addEventListener("online", wake);
    const unsubscribeQuery = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "error" &&
        current() &&
        JSON.stringify(event.query.queryKey) === JSON.stringify(threadQueryKeys.snapshot(threadId))
      ) {
        const availability = threadAvailability(event.query.state.error, accountId);
        if (availability === "deleted" || availability === "project-deleted")
          void cleanDeletedChat(accountId, threadId, projectId, availability).catch(reportError);
      }
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        JSON.stringify(event.query.queryKey) === JSON.stringify(threadQueryKeys.snapshot(threadId))
      )
        wake();
    });
    const unsubscribeConnection = transport?.onConnectionState((state) => {
      if (state.kind === "connected") wake();
    });
    return () => {
      unregisterDeletion();
      lifetime.abort();
      for (const key of announcementKeys) clearAnnouncement(key);
      owner.dispose();
      if (driver.current === owner) driver.current = null;
      unsubscribe();
      unsubscribeQuery();
      unsubscribeConnection?.();
      window.removeEventListener("storage", storage);
      window.removeEventListener("online", wake);
    };
  }, [threadId, projectId, accountId, controller, accountSignal, queryClient, transport]);

  const onAnswered = useCallback(
    (listener: (answer: SwitchAnswer) => void) => onSwitchAnswered(accountId, threadId, listener),
    [accountId, threadId],
  );
  return {
    presentation: driver.current?.presentation,
    submit: (envelope: ComposerSubmitEnvelope) =>
      driver.current?.submit(envelope) ?? Promise.resolve(false),
    /** Write-mode switches ride the same journal, so they are posted in order with the messages. */
    switches: {
      pending: driver.current?.switches ?? NO_SWITCHES,
      submit: (id: string, mode: AiWriteMode, after?: SwitchFrontier) =>
        driver.current?.submitSwitch(id, mode, after) ?? false,
      retry: (id: string) => driver.current?.retrySwitch(id),
      withdraw: (id: string) => driver.current?.withdrawSwitch(id) ?? Promise.resolve("admitted"),
      onAnswered,
    },
  };
}
