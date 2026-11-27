import type {
  CommandDriver,
  CommandKind,
  CommandRecord,
  HttpRequest,
} from "@meridian/command-driver";
import {
  apiThreadPath,
  apiThreadRestorePath,
  apiThreadTitlePath,
  apiThreadUserStatePath,
} from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { isThreadAwaitingCreation, subscribeChatSubmissions } from "@/client/chat-submissions";
import type { CommandDomain } from "@/client/commands/driver-context";
import { useCommandDriver } from "@/client/commands/driver-context";
import { settleCommand } from "@/client/commands/submit";
import { projectQueryKeys } from "./project-query-keys";
import { renameCommand } from "./rename-command";
import { threadQueryKeys } from "./thread-query-keys";
import { rereadThenObserve } from "./when-read";

export const CHAT_RENAME_KIND = "chat_rename";
export const CHAT_FAVORITE_KIND = "chat_favorite";
export const CHAT_DELETE_KIND = "chat_delete";
export const CHAT_RESTORE_KIND = "chat_restore";

type ChatBody = { projectId: string; threadId: string };
type ChatRenameBody = ChatBody & { title: string };
type ChatFavoriteBody = ChatBody & { isFavorite: boolean };

export const chatLane = (threadId: string) => `chat:${threadId}`;

type ChatChange = { title?: string; isFavorite?: boolean; deleted?: boolean };

export type ChatRestoreResult = { keptWith: { workId: string; name: string } | null };

const restoreBroughtBack = (record: CommandRecord) =>
  record.state === "done" && !(record.outcome?.result as ChatRestoreResult | undefined)?.keptWith;

function chatChanges(records: readonly CommandRecord[]): Map<string, ChatChange> {
  const changes = new Map<string, ChatChange>();
  for (const record of records) {
    if (record.state === "never" || (record.state === "done" && record.observed)) continue;
    const body = record.body as ChatBody;
    const change = () => {
      const current = changes.get(body.threadId) ?? {};
      changes.set(body.threadId, current);
      return current;
    };
    if (record.kind === CHAT_RENAME_KIND) change().title = (body as ChatRenameBody).title;
    else if (record.kind === CHAT_FAVORITE_KIND)
      change().isFavorite = (body as ChatFavoriteBody).isFavorite;
    else if (record.kind === CHAT_DELETE_KIND) change().deleted = true;
    else if (record.kind === CHAT_RESTORE_KIND && restoreBroughtBack(record))
      change().deleted = false;
  }
  return changes;
}

export function projectChats<
  Chat extends { id: string; title: string | null; isFavorite?: boolean },
>(records: readonly CommandRecord[], chats: Chat[]): Chat[] {
  const changes = chatChanges(records);
  if (changes.size === 0) return chats;
  const shown: Chat[] = [];
  for (const chat of chats) {
    const change = changes.get(chat.id);
    if (change?.deleted) continue;
    const title = change?.title ?? chat.title;
    const isFavorite =
      chat.isFavorite === undefined ? undefined : (change?.isFavorite ?? chat.isFavorite);
    shown.push(
      title === chat.title && isFavorite === chat.isFavorite
        ? chat
        : { ...chat, title, ...(isFavorite === undefined ? {} : { isFavorite }) },
    );
  }
  return shown;
}

export function projectPinnedChats(
  records: readonly CommandRecord[],
  confirmed: readonly string[],
): Set<string> {
  const pinned = new Set(confirmed);
  for (const [threadId, { isFavorite }] of chatChanges(records)) {
    if (isFavorite === true) pinned.add(threadId);
    if (isFavorite === false) pinned.delete(threadId);
  }
  return pinned;
}

function untilCreated(accountId: string, threadId: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!signal.aborted && isThreadAwaitingCreation(accountId, threadId)) return;
      stop();
      signal.removeEventListener("abort", check);
      resolve();
    };
    const stop = subscribeChatSubmissions(check);
    signal.addEventListener("abort", check);
    check();
  });
}

export function chatCommandDomain(client: QueryClient): CommandDomain {
  let bound: { driver: CommandDriver; accountId: string } | null = null;
  const threads = (projectId: string) => ({
    queryKey: projectQueryKeys.threads(projectId),
    exact: true,
  });
  const feeds = (projectId: string) => ({ queryKey: projectQueryKeys.chatFeed(projectId) });
  const kind = (
    request: (body: ChatBody) => HttpRequest,
    reads: (projectId: string) => { queryKey: readonly unknown[]; exact?: boolean }[],
    settled?: (record: CommandRecord) => void,
  ): CommandKind => ({
    version: 1,
    migrate: (body) => body as ChatBody,
    request: ({ body }) => request(body as ChatBody),
    ready: (record, signal) =>
      bound
        ? untilCreated(bound.accountId, (record.body as ChatBody).threadId, signal)
        : Promise.resolve(),
    onSettled: (record) => {
      settled?.(record);
      rereadThenObserve(
        client,
        bound?.driver,
        (each) => each.id === record.id,
        reads((record.body as ChatBody).projectId),
      );
    },
  });
  const removal = (record: CommandRecord) => {
    const { projectId, threadId } = record.body as ChatBody;
    void client.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
    if (record.kind === CHAT_RESTORE_KIND && record.state === "done")
      // Reset, not invalidate: a kept "deleted" error would read as proof the chat is gone when it
      // next mounts, and drop its unsent words.
      void client.resetQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  };
  const kinds: Record<string, CommandKind> = {
    [CHAT_RENAME_KIND]: kind(
      (body) => ({
        method: "PATCH",
        path: apiThreadTitlePath(body.threadId),
        body: { title: (body as ChatRenameBody).title },
      }),
      (projectId) => [threads(projectId), feeds(projectId)],
    ),
    [CHAT_FAVORITE_KIND]: kind(
      (body) => ({
        method: "PATCH",
        path: apiThreadUserStatePath(body.threadId),
        body: { isFavorite: (body as ChatFavoriteBody).isFavorite },
      }),
      (projectId) => [feeds(projectId)],
    ),
    [CHAT_DELETE_KIND]: kind(
      (body) => ({ method: "DELETE", path: apiThreadPath(body.threadId), body: {} }),
      (projectId) => [threads(projectId), feeds(projectId)],
      removal,
    ),
    [CHAT_RESTORE_KIND]: kind(
      (body) => ({ method: "POST", path: apiThreadRestorePath(body.threadId), body: {} }),
      (projectId) => [threads(projectId), feeds(projectId)],
      removal,
    ),
  };
  return {
    kinds,
    bind: (driver, accountId) => {
      const mine = { driver, accountId };
      bound = mine;
      return () => {
        if (bound === mine) bound = null;
      };
    },
  };
}

export function useRenameChat(
  projectId: string,
  threadId: string,
  onRenamed?: (title: string) => void,
): (title: string) => Promise<void> {
  const driver = useCommandDriver();
  return useCallback(
    (title: string) =>
      renameCommand(
        driver,
        {
          kind: CHAT_RENAME_KIND,
          lanes: [chatLane(threadId)],
          body: { projectId, threadId, title: title.trim() } satisfies ChatRenameBody,
        },
        onRenamed,
      ),
    [driver, projectId, threadId, onRenamed],
  );
}

export function pinChat(
  driver: CommandDriver | null,
  projectId: string,
  threadId: string,
  isFavorite: boolean,
): Promise<CommandRecord | null> {
  return settleCommand(driver, {
    kind: CHAT_FAVORITE_KIND,
    lanes: [chatLane(threadId)],
    body: { projectId, threadId, isFavorite } satisfies ChatFavoriteBody,
  });
}

export function trashChat(
  driver: CommandDriver | null,
  kind: typeof CHAT_DELETE_KIND | typeof CHAT_RESTORE_KIND,
  projectId: string,
  threadId: string,
): Promise<CommandRecord | null> {
  return settleCommand(driver, {
    kind,
    lanes: [chatLane(threadId)],
    body: { projectId, threadId } satisfies ChatBody,
  });
}
