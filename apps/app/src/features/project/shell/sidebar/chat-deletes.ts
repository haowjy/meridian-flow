import { t } from "@lingui/core/macro";
import type { QueryClient } from "@tanstack/react-query";
import {
  cleanDeletedChat,
  restoreOwnDeletedChatWords,
} from "@/client/chat-submissions/deleted-chat";
import { probeChatDestination } from "@/client/chat-submissions/thread-availability";
import { readLastShownChat, writeLastShownChat } from "@/client/project-shell/store";
import {
  type ChatCommandOutcome,
  deleteProjectChat,
  restoreProjectChat,
} from "@/client/query/delete-project-chat";
import { announce, announceError } from "@/client/stores";
import type { ChatNavigation } from "../../routing/chat-navigation";

export type ChatDeleteNotice = {
  id: number;
  threadId: string;
  title: string;
  status: "ready" | "restoring" | "failed";
  place: ChatPlace | null;
};

export type ChatPlace = { list: string; after: readonly string[] };

export type ChatDeleteRefusal = { threadId: string; title: string };

type Ports = {
  client: QueryClient;
  accountId: string;
  projectId: string;
  navigation(): ChatNavigation;
};

type Taken = { main: boolean; current: boolean };

type Held = {
  notice: ChatDeleteNotice;
  taken: Taken;
  moved: Promise<unknown>;
  landed: Promise<boolean>;
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

  delete(threadId: string, title: string, place: ChatPlace | null = null): void {
    if (this.closed) return;
    this.end();
    this.refusal = null;
    const { client, accountId, projectId } = this.ports;
    const taken = this.takeAway(threadId);
    const moved = this.moveWords(threadId, title);
    const notice: ChatDeleteNotice = {
      id: this.nextId++,
      threadId,
      title,
      status: "ready",
      place,
    };
    const held: Held = {
      notice,
      taken,
      moved,
      ended: false,
      landed: deleteProjectChat(client, projectId, threadId).then((outcome) => {
        if (outcome.status === "success") {
          announce(t`Chat deleted`);
          return true;
        }
        if (this.held === held) this.held = null;
        void moved.then(() => restoreOwnDeletedChatWords(accountId, threadId));
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

  takeFocus(id: number): boolean {
    if (this.focusPending !== id) return false;
    this.focusPending = null;
    return true;
  }

  async undo(): Promise<boolean> {
    const held = this.held;
    if (!held || held.notice.status === "restoring") return false;
    this.update(held, "restoring");
    if (!(await held.landed)) return false;
    const { threadId, title } = held.notice;
    await held.moved;
    restoreOwnDeletedChatWords(this.ports.accountId, threadId);
    if (!held.ended) this.putBack(threadId, held.taken);
    const outcome = await restoreProjectChat(this.ports.client, this.ports.projectId, threadId);
    if (outcome.status === "success") {
      if (this.held === held) this.held = null;
      this.publish();
      announce(t`${title} restored`);
      return true;
    }
    if (held.ended) return false;
    this.takeAway(threadId);
    held.moved = this.moveWords(threadId, title);
    this.update(held, "failed");
    announceError(t`Couldn't restore ${title}`);
    return false;
  }

  async restore(threadId: string): Promise<ChatCommandOutcome> {
    const outcome = await restoreProjectChat(this.ports.client, this.ports.projectId, threadId);
    const held = this.held;
    if (outcome.status !== "success" || !held || held.notice.status === "restoring") return outcome;
    if (!(await held.landed)) return outcome;
    const back =
      held.notice.threadId === threadId || (await this.probe(held.notice.threadId)) === "present";
    if (back && this.held === held) {
      this.held = null;
      this.publish();
    }
    return outcome;
  }

  dismiss = () => this.end();

  open() {
    this.closed = false;
  }

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
  }

  private moveWords(threadId: string, title: string) {
    const { accountId, projectId } = this.ports;
    return cleanDeletedChat(
      accountId,
      threadId,
      projectId,
      "own-delete",
      undefined,
      false,
      undefined,
      title,
    ).catch(reportError);
  }

  private probe(threadId: string) {
    return probeChatDestination(this.ports.accountId, threadId);
  }

  private takeAway(threadId: string): Taken {
    const { accountId, projectId } = this.ports;
    const navigation = this.ports.navigation();
    const display = navigation.display;
    const taken: Taken = {
      main: display?.kind === "thread" && display.threadId === threadId,
      current: readLastShownChat(accountId, projectId) === threadId,
    };
    navigation.forgetChat(threadId);
    if (taken.main) void navigation.openNewChat({ replace: true, focus: false });
    return taken;
  }

  private putBack(threadId: string, taken: Taken) {
    const { accountId, projectId } = this.ports;
    const navigation = this.ports.navigation();
    if (taken.current && readLastShownChat(accountId, projectId) === null)
      writeLastShownChat(accountId, projectId, threadId);
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
