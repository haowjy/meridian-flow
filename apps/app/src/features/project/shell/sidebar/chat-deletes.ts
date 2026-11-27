import { t } from "@lingui/core/macro";
import type { CommandDriver } from "@meridian/command-driver";
import type { QueryClient } from "@tanstack/react-query";
import { announce, announceError } from "@/client/announcements";
import {
  cleanDeletedChat,
  restoreOwnDeletedChatWords,
} from "@/client/chat-submissions/deleted-chat";
import { rerecordSubmissions } from "@/client/chat-submissions/owner";
import { readLastShownChat, writeLastShownChat } from "@/client/project-shell/store";
import {
  CHAT_DELETE_KIND,
  CHAT_RESTORE_KIND,
  type ChatRestoreResult,
  trashChat,
} from "@/client/query/chat-commands";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { whenRead } from "@/client/query/when-read";
import type { ThreadStoreActions } from "@/client/stores";
import type { ChatNavigation } from "../../routing/chat-navigation";

export type ChatDeleteNotice = {
  id: number;
  threadId: string;
  title: string;
  status: "ready" | "restoring" | "failed" | "kept";
  keptWith?: string;
  place: ChatPlace;
};

export type ChatPlace = { work: string | null; pinned: boolean; after: readonly string[] };

export type ChatDeleteRefusal = { threadId: string; title: string };

type Ports = {
  client: QueryClient;
  driver: () => CommandDriver | null;
  actions: () => ThreadStoreActions;
  accountId: string;
  projectId: string;
  navigation(): ChatNavigation;
};

type Taken = { main: boolean; current: boolean };

type Held = {
  notice: ChatDeleteNotice;
  taken: Taken;
  moved: Promise<unknown>;
  landed: Promise<unknown>;
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

  delete(threadId: string, title: string, place: ChatPlace): void {
    if (this.closed) return;
    this.end();
    this.refusal = null;
    const { projectId } = this.ports;
    const taken = this.takeAway(threadId);
    const moved = this.moveWords(threadId, title);
    const notice: ChatDeleteNotice = {
      id: this.nextId++,
      threadId,
      title,
      status: "ready",
      place,
    };
    const held: Held = { notice, taken, moved, landed: Promise.resolve(), ended: false };
    held.landed = trashChat(this.ports.driver(), CHAT_DELETE_KIND, projectId, threadId).then(
      (done) => {
        if (done) announce(t`Chat deleted`);
      },
      () => {
        if (this.held === held) this.held = null;
        void moved.then(() => this.restoreWords(threadId, Promise.resolve()));
        if (!this.closed) {
          this.putBack(threadId, taken);
          this.refusal = { threadId, title };
        }
        this.publish();
        announceError(t`Couldn't delete ${title}`);
      },
    );
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
    if (!held || held.notice.status === "restoring" || held.notice.status === "kept") return false;
    this.update(held, "restoring");
    const { threadId, title } = held.notice;
    await held.moved;
    void this.restoreWords(threadId, held.landed).then(() => {
      if (!held.ended) this.putBack(threadId, held.taken);
    });
    const restored = await this.restored(threadId);
    if (restored === true) {
      if (this.held === held) this.held = null;
      this.publish();
      announce(t`${title} restored`);
      return true;
    }
    if (held.ended) return false;
    this.takeAway(threadId);
    held.moved = this.moveWords(threadId, title);
    if (restored) {
      const work = restored.keptWith;
      held.notice = { ...held.notice, status: "kept", keptWith: work };
      this.publish();
      announce(t`${title} comes back when ${work} is restored`);
      return false;
    }
    this.update(held, "failed");
    announceError(t`Couldn't restore ${title}`);
    return false;
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

  private restoreWords(threadId: string, landed: Promise<unknown>) {
    const { accountId } = this.ports;
    return restoreOwnDeletedChatWords(accountId, threadId, (entries) =>
      landed.then(() => rerecordSubmissions(accountId, entries, this.ports.actions())),
    );
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

  private async restored(threadId: string): Promise<boolean | { keptWith: string }> {
    const { client, projectId } = this.ports;
    const read = Promise.all([
      whenRead(client, { queryKey: projectQueryKeys.threads(projectId), exact: true }),
      whenRead(client, { queryKey: projectQueryKeys.chatFeed(projectId) }),
    ]);
    let settled: Awaited<ReturnType<typeof trashChat>>;
    try {
      settled = await trashChat(this.ports.driver(), CHAT_RESTORE_KIND, projectId, threadId);
    } catch {
      return false;
    }
    if (!settled) return false;
    const keptWith = (settled.outcome?.result as ChatRestoreResult | undefined)?.keptWith;
    if (keptWith) return { keptWith: keptWith.name };
    await read;
    return true;
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
