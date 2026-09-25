/**
 * Favorite and Delete for any list of project chats: one command, one
 * confirmation, and one announcement wherever a chat row appears. Deleting
 * the current chat also lets it go, so no list has to remember to.
 */
import { t } from "@lingui/core/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { deleteProjectChat } from "@/client/query/delete-project-chat";
import { runFavoriteCommand } from "@/client/query/thread-user-state-commands";
import { useAnnouncement } from "@/client/stores";
import { displayThreadTitle } from "@/lib/thread-title";
import { useChatNavigation } from "../routing/chat-navigation";
import { DeleteChatDialog, type DeleteChatTarget } from "./DeleteChatDialog";

export function useChatRowCommands(projectId: string) {
  const client = useQueryClient();
  const { forgetChat } = useChatNavigation();
  const { announce, announceError } = useAnnouncement();
  const [target, setTarget] = useState<DeleteChatTarget | null>(null);
  const deletion = useMutation({
    mutationFn: (threadId: string) => deleteProjectChat(client, projectId, threadId),
    onSuccess: (_result, threadId) => {
      forgetChat(threadId);
      setTarget(null);
      announce(t`Chat deleted`);
    },
  });
  const close = () => {
    if (deletion.isPending) return;
    deletion.reset();
    setTarget(null);
  };

  return {
    onFavorite: (item: ProjectChatItem, value: boolean) => {
      const title = displayThreadTitle(item.title);
      void runFavoriteCommand(client, projectId, item.id, value).then((outcome) => {
        if (outcome.status !== "success") announceError(t`Favorite wasn’t saved`);
        else announce(value ? t`${title} added to Favorites` : t`${title} removed from Favorites`);
      });
    },
    onDelete: (item: ProjectChatItem) => {
      deletion.reset();
      setTarget({ id: item.id, title: displayThreadTitle(item.title) });
    },
    deleteDialog: (
      <DeleteChatDialog
        target={target}
        isPending={deletion.isPending}
        error={deletion.error}
        onCancel={close}
        onConfirm={() => target && deletion.mutate(target.id)}
      />
    ),
  };
}
