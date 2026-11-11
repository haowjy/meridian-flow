/**
 * Favorite, Delete and the delete's Undo for any list of project chats: one command and one
 * announcement wherever a chat row appears.
 *
 * Delete asks nothing and is optimistic: the row leaves every cache and the current chat is
 * forgotten at once, ahead of the server's confirmation. A failure restores the row from its
 * pre-delete snapshot and surfaces the error on that row (`deleteFailure`). A delete that lands
 * leaves `deleted`, whose Undo brings the chat back from Trash.
 */
import { t } from "@lingui/core/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { deleteProjectChat, restoreProjectChat } from "@/client/query/delete-project-chat";
import { runFavoriteCommand } from "@/client/query/thread-user-state-commands";
import { useAnnouncement } from "@/client/stores";
import { displayThreadTitle } from "@/lib/thread-title";
import { useChatNavigation } from "../../routing/chat-navigation";

/** A chat as its row's commands name it. */
export type ChatRowTarget = { id: string; title: string | null };

export type ChatRowDeleteFailure = { id: string; title: string; error: Error };

/** The chat the writer just deleted, with its Undo's state. */
export type DeletedChat = { id: string; title: string; restore: "idle" | "restoring" | "failed" };

export function useChatRowCommands(projectId: string) {
  const client = useQueryClient();
  const { forgetChat } = useChatNavigation();
  const { announce, announceError } = useAnnouncement();
  const [deleteFailure, setDeleteFailure] = useState<ChatRowDeleteFailure | null>(null);
  const [deleted, setDeleted] = useState<DeletedChat | null>(null);

  const onFavorite = useCallback(
    (item: ChatRowTarget, value: boolean) => {
      const title = displayThreadTitle(item.title);
      void runFavoriteCommand(client, projectId, item.id, value).then((outcome) => {
        if (outcome.status !== "success") announceError(t`Favorite wasn’t saved`);
        else announce(value ? t`${title} added to Favorites` : t`${title} removed from Favorites`);
      });
    },
    [client, projectId, announce, announceError],
  );

  const runDelete = useCallback(
    (id: string, title: string) => {
      setDeleteFailure(null);
      setDeleted(null);
      // Optimistic: the row and the current-chat pointer let go before the server confirms.
      forgetChat(id);
      void deleteProjectChat(client, projectId, id).then((outcome) => {
        if (outcome.status === "success") {
          setDeleted({ id, title, restore: "idle" });
          announce(t`Chat deleted`);
        } else {
          setDeleteFailure({ id, title, error: outcome.error });
          announceError(t`Couldn't delete ${title}`);
        }
      });
    },
    [client, projectId, forgetChat, announce, announceError],
  );

  const onDelete = useCallback(
    (item: ChatRowTarget) => runDelete(item.id, displayThreadTitle(item.title)),
    [runDelete],
  );

  const retryDelete = useCallback(() => {
    if (deleteFailure) runDelete(deleteFailure.id, deleteFailure.title);
  }, [deleteFailure, runDelete]);

  const undoDelete = useCallback(() => {
    if (!deleted || deleted.restore === "restoring") return;
    const { id, title } = deleted;
    setDeleted({ id, title, restore: "restoring" });
    void restoreProjectChat(client, projectId, id).then((outcome) => {
      if (outcome.status === "success") {
        setDeleted((current) => (current?.id === id ? null : current));
        announce(t`${title} restored`);
      } else {
        setDeleted((current) => (current?.id === id ? { id, title, restore: "failed" } : current));
        announceError(t`Couldn't restore ${title}`);
      }
    });
  }, [deleted, client, projectId, announce, announceError]);

  return {
    onFavorite,
    onDelete,
    deleteFailure,
    retryDelete,
    deleted,
    undoDelete,
    dismissDeleted: () => setDeleted(null),
  };
}
