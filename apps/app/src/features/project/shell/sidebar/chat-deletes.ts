/**
 * The project's chat deletes: one notice, "Deleted ‹title›" with its Undo, replaced by the next
 * delete. The project owns it, so switching the sidebar's list, closing the phone's drawer or
 * remounting the sidebar keeps it; leaving the project, signing out or reloading ends it.
 *
 * A delete takes what showed the chat at once (main goes to a new chat, the side lets go of a
 * held pick) and leaves its saved words alone: the composer's draft and unsent records stay
 * while the Undo can still bring the chat back, and go when the notice ends without one. Undo
 * puts back each thing the delete took that nothing has replaced since.
 */
import { t } from "@lingui/core/macro";
import type { QueryClient } from "@tanstack/react-query";
import { beginOwnChatDelete, cleanDeletedChat } from "@/client/chat-submissions/deleted-chat";
import {
  type HeldPick,
  readHeldPick,
  readLastChat,
  writeHeldPick,
  writeLastChat,
} from "@/client/project-shell/store";
import { deleteProjectChat, restoreProjectChat } from "@/client/query/delete-project-chat";
import { announce, announceError } from "@/client/stores";
import type { ChatNavigation } from "../../routing/chat-navigation";

export type ChatDeleteNotice = {
  id: number;
  threadId: string;
  title: string;
  status: "ready" | "restoring" | "failed";
};

/** A delete the server refused: the chat is back, and its row says so with Retry. */
export type ChatDeleteRefusal = { threadId: string; title: string };

type Ports = {
  client: QueryClient;
  accountId: string;
  projectId: string;
  navigation(): ChatNavigation;
};

/** What the delete took from the screen, for Undo to put back. */
type Taken = { main: boolean; pick: HeldPick | null; last: boolean };

type Held = {
  notice: ChatDeleteNotice;
  taken: Taken;
  mark: ReturnType<typeof beginOwnChatDelete>;
  /** True once the server has the chat in Trash. */
  landed: Promise<boolean>;
  /** The notice ended while its Undo was in flight: a failed Undo cleans up after it. */
  ended: boolean;
};

export class ChatDeletes {
  private held: Held | null = null;
  private refusal: ChatDeleteRefusal | null = null;
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private closed = false;
  private focusPending: number | null = null;

  constructor(private readonly ports: Ports) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  notice = (): ChatDeleteNotice | null => this.held?.notice ?? null;
  refused = (): ChatDeleteRefusal | null => this.refusal;

  delete(threadId: string, title: string): void {
    if (this.closed) return;
    this.end();
    this.refusal = null;
    const { client, accountId, projectId } = this.ports;
    const mark = beginOwnChatDelete(accountId, threadId);
    const taken = this.takeAway(threadId);
    const notice: ChatDeleteNotice = { id: this.nextId++, threadId, title, status: "ready" };
    const held: Held = {
      notice,
      taken,
      mark,
      ended: false,
      landed: deleteProjectChat(client, projectId, threadId).then((outcome) => {
        if (outcome.status === "success") {
          announce(t`Chat deleted`);
          return true;
        }
        mark.cancel();
        if (this.held === held) this.held = null;
        if (!this.closed) {
          this.putBack(threadId, taken);
          this.refusal = { threadId, title };
        }
        this.publish();
        announceError(t`Couldn't delete ${title}`);
        return false;
      }),
    };
    this.held = held;
    this.focusPending = notice.id;
    this.publish();
  }

  /** True once per delete, for the notice line to take focus when the delete makes it. */
  takeFocus(id: number): boolean {
    if (this.focusPending !== id) return false;
    this.focusPending = null;
    return true;
  }

  /** Brings the chat back; true once the server and every list have it again. */
  async undo(): Promise<boolean> {
    const held = this.held;
    if (!held || held.notice.status === "restoring") return false;
    this.update(held, "restoring");
    if (!(await held.landed)) return false;
    const { threadId, title } = held.notice;
    // Navigate first: main is back on the chat while the server restores it.
    if (!held.ended) this.putBack(threadId, held.taken);
    const outcome = await restoreProjectChat(this.ports.client, this.ports.projectId, threadId);
    if (outcome.status === "success") {
      held.mark.cancel();
      if (this.held === held) this.held = null;
      this.publish();
      announce(t`${title} restored`);
      return true;
    }
    if (held.ended) {
      this.clean(held);
      return false;
    }
    // Still in Trash: what Undo put back lets go again.
    this.takeAway(threadId);
    this.update(held, "failed");
    announceError(t`Couldn't restore ${title}`);
    return false;
  }

  /** The notice ends without Undo: the chat's saved words go. */
  dismiss = () => this.end();

  open() {
    this.closed = false;
  }

  /** The writer left the project or signed out. */
  close() {
    this.closed = true;
    this.end();
  }

  private end() {
    const held = this.held;
    if (!held) return;
    this.held = null;
    held.ended = true;
    this.publish();
    if (held.notice.status !== "restoring") this.clean(held);
  }

  private clean(held: Held) {
    const { accountId, projectId } = this.ports;
    void held.landed.then((landed) => {
      if (!landed) return;
      held.mark.release();
      void cleanDeletedChat(accountId, held.notice.threadId, projectId, "own-delete").catch(
        reportError,
      );
    });
  }

  private takeAway(threadId: string): Taken {
    const { accountId, projectId } = this.ports;
    const navigation = this.ports.navigation();
    const display = navigation.display;
    const pick = readHeldPick(accountId, projectId);
    const taken: Taken = {
      main: display?.kind === "thread" && display.threadId === threadId,
      pick: pick?.kind === "chat" && pick.chatId === threadId ? pick : null,
      last: readLastChat(accountId, projectId) === threadId,
    };
    navigation.forgetChat(threadId);
    // Focus stays with the notice's Undo, not the new chat's composer.
    if (taken.main) void navigation.openNewChat({ replace: true, focus: false });
    return taken;
  }

  /** Each thing goes back only where nothing has replaced it since. */
  private putBack(threadId: string, taken: Taken) {
    const { accountId, projectId } = this.ports;
    const navigation = this.ports.navigation();
    if (taken.last && readLastChat(accountId, projectId) === null)
      writeLastChat(accountId, projectId, threadId);
    if (taken.pick && readHeldPick(accountId, projectId) === null)
      writeHeldPick(accountId, projectId, taken.pick);
    if (taken.main && navigation.display?.kind === "new")
      void navigation.openChat(threadId, { replace: true });
  }

  private update(held: Held, status: ChatDeleteNotice["status"]) {
    held.notice = { ...held.notice, status };
    this.publish();
  }

  private publish() {
    for (const listener of [...this.listeners]) listener();
  }
}
