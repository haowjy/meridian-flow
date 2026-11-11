/**
 * Favorite and Delete for any list of project chats: one command, one
 * confirmation, and one announcement wherever a chat row appears.
 *
 * Delete is optimistic: the row leaves every cache, the dialog closes, and
 * the current chat is forgotten immediately, ahead of the server's
 * confirmation. A failure restores the row from its pre-delete snapshot and
 * surfaces the error on that row (`deleteFailure`), the same place a failed
 * Favorite already does.
 */
import { t } from "@lingui/core/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { deleteProjectChat } from "@/client/query/delete-project-chat";
import { runFavoriteCommand } from "@/client/query/thread-user-state-commands";
import { useAnnouncement } from "@/client/stores";
import { lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { displayThreadTitle } from "@/lib/thread-title";
import { useChatNavigation } from "../routing/chat-navigation";
import { DeleteChatDialog, type DeleteChatTarget } from "./DeleteChatDialog";

export type ChatRowDeleteFailure = { id: string; title: string; error: Error };

export function useChatRowCommands(projectId: string) {
  const client = useQueryClient();
  const { forgetChat } = useChatNavigation();
  const { announce, announceError } = useAnnouncement();
  const [target, setTarget] = useState<DeleteChatTarget | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<ChatRowDeleteFailure | null>(null);
  // The dialog opens from a menu item that is gone when it closes: Cancel goes
  // back to the row's Actions button, Delete to the row beside the deleted one.
  const returnFocus = useRef<{ rowId: string; selector: string } | null>(null);

  const onFavorite = useCallback(
    (item: ProjectChatItem, value: boolean) => {
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
      // Optimistic: the row and the current-chat pointer let go before the
      // server confirms, and the dialog is already closed by the caller.
      forgetChat(id);
      void deleteProjectChat(client, projectId, id).then((outcome) => {
        if (outcome.status === "success") {
          announce(t`Chat deleted`);
        } else {
          setDeleteFailure({ id, title, error: outcome.error });
          announceError(t`Couldn't delete ${title}`);
        }
      });
    },
    [client, projectId, forgetChat, announce, announceError],
  );

  const onDelete = useCallback((item: ProjectChatItem) => {
    returnFocus.current = { rowId: item.id, selector: ':scope button[aria-haspopup="menu"]' };
    setDeleteFailure(null);
    setTarget({ id: item.id, title: displayThreadTitle(item.title) });
  }, []);

  const retryDelete = useCallback(() => {
    if (deleteFailure) runDelete(deleteFailure.id, deleteFailure.title);
  }, [deleteFailure, runDelete]);

  return {
    onFavorite,
    onDelete,
    deleteFailure,
    retryDelete,
    deleteDialog: (
      <DeleteChatDialog
        target={target}
        onCancel={() => setTarget(null)}
        onConfirm={() => {
          if (!target) return;
          const { id, title } = target;
          const neighbour = neighbourRowId(id);
          returnFocus.current = neighbour
            ? { rowId: neighbour, selector: ":scope > button" }
            : null;
          setTarget(null);
          runDelete(id, title);
        }}
        onCloseAutoFocus={(event) => {
          const to = returnFocus.current;
          returnFocus.current = null;
          const element = to ? rowElement(to.rowId)?.querySelector<HTMLElement>(to.selector) : null;
          if (!element) return;
          event.preventDefault();
          moveFocus(element, { ring: lastInputWasKeyboard() });
        }}
      />
    ),
  };
}

const rowElement = (id: string) =>
  document.querySelector<HTMLElement>(`[data-project-chat-row="${CSS.escape(id)}"]`);

/** The next row in the list, or the previous one when the deleted chat was last. */
function neighbourRowId(id: string): string | null {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-project-chat-row]")];
  const index = rows.findIndex((row) => row.dataset.projectChatRow === id);
  if (index < 0) return null;
  return (rows[index + 1] ?? rows[index - 1])?.dataset.projectChatRow ?? null;
}
