import type { CommandDriver, CommandKind, CommandRecord } from "@meridian/command-driver";
import { apiThreadTitlePath } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { isThreadAwaitingCreation, subscribeChatSubmissions } from "@/client/chat-submissions";
import type { CommandDomain } from "@/client/commands/driver-context";
import { useCommandDriver } from "@/client/commands/driver-context";
import { projectQueryKeys } from "./project-query-keys";
import { projectRenames, renameCommand } from "./rename-command";
import { rereadThenObserve } from "./when-read";

export const CHAT_RENAME_KIND = "chat_rename";

type ChatRenameBody = { projectId: string; threadId: string; title: string };

export const chatLane = (threadId: string) => `chat:${threadId}`;

export const projectChatTitles = <Chat extends { id: string; title: string | null }>(
  records: readonly CommandRecord[],
  chats: Chat[],
) => projectRenames(records, CHAT_RENAME_KIND, (body) => (body as ChatRenameBody).threadId, chats);

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

export function chatRenameDomain(client: QueryClient): CommandDomain {
  let bound: { driver: CommandDriver; accountId: string } | null = null;
  const kinds: Record<string, CommandKind> = {
    [CHAT_RENAME_KIND]: {
      version: 1,
      migrate: (body) => body as ChatRenameBody,
      request: ({ body }) => {
        const { threadId, title } = body as ChatRenameBody;
        return { method: "PATCH", path: apiThreadTitlePath(threadId), body: { title } };
      },
      ready: (record, signal) =>
        bound
          ? untilCreated(bound.accountId, (record.body as ChatRenameBody).threadId, signal)
          : Promise.resolve(),
      onSettled: (record) => {
        const { projectId } = record.body as ChatRenameBody;
        rereadThenObserve(client, bound?.driver, record, [
          { queryKey: projectQueryKeys.threads(projectId), exact: true },
          { queryKey: projectQueryKeys.chatFeed(projectId) },
        ]);
      },
    },
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
