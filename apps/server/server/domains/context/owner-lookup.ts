/**
 * The one answer to "who owns this address": the chat, subagent, lineage or Work a handle or a
 * near-miss name stands for, in the caller's project. Near-miss errors, the thread tools'
 * not-connected pointer, `ls scratch://@` and the receipt lines all read it, so they name only
 * addresses that resolve and show each handle beside its label.
 */
import { formatParsedContextUri } from "@meridian/contracts/context-uri";
import type { WorkHandle } from "@meridian/contracts/handles";
import type { ChatUploadsOwners } from "./chat-uploads-owners.js";
import type { ScratchLineages } from "./scratch-owner.js";

export interface ChatFileAddresses {
  /** The chat's uploads, `uploads://@c15/`. */
  uploads: string;
  /** Its Work's Scratch (`scratch://@w3/`), or in No Work its lineage's (`scratch://@c12/`). */
  scratch: string;
}

export type WorkOwnerState = "active" | "archived" | "deleted";

export interface WorkOwner {
  handle: WorkHandle;
  name: string;
  state: WorkOwnerState;
  /** Days left to restore a deleted Work; null while it is not deleted or the window has passed. */
  restorableDays: number | null;
}

/** A row of `ls scratch://@` or `ls uploads://@`: the owner's address and the label beside it. */
export interface OwnerRow {
  uri: string;
  label: string;
}

export interface OwnerLookup {
  /** A live chat of `projectId` by its `c` handle: where its files are. Null for anything else. */
  chat(projectId: string, ref: string): Promise<ChatFileAddresses | null>;
  /** A subagent by its `p` handle: the chat it belongs to and that chat's addresses. */
  subagent(
    projectId: string,
    ref: string,
  ): Promise<(ChatFileAddresses & { chatRef: string }) | null>;
  /** A Work by handle, deleted ones included; null when the project never minted it. */
  work(projectId: string, handle: string): Promise<WorkOwner | null>;
  /** The one non-deleted Work a name (`Tea Notes` or `tea-notes`) stands for, if exactly one. */
  workNamed(projectId: string, name: string): Promise<WorkOwner | null>;
  scratchOwners(projectId: string): Promise<OwnerRow[]>;
  uploadOwners(projectId: string): Promise<OwnerRow[]>;
}

export interface OwnerLookupDeps {
  chats: ChatUploadsOwners;
  lineages: ScratchLineages;
  /** The handle of the named Work the chat is bound to; null in No Work. */
  namedWorkHandle(threadId: string): Promise<string | null>;
  /** The `c` handle of the chat a `p` handle belongs to; null when there is no such subagent. */
  subagentChatRef(projectId: string, ref: string): Promise<string | null>;
  /** Every Work of the project, deleted ones too. */
  works(projectId: string): Promise<WorkOwner[]>;
  /** Chats of the project that have uploaded files, with their titles. */
  chatsWithFiles(projectId: string): Promise<{ chatRef: string; title: string | null }[]>;
}

/** Two spellings of one name compare equal: `Tea Notes` and `tea-notes`. */
export function workNameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The one non-deleted Work a name stands for: an exact match first, else the only look-alike. */
export function findWorkNamed<T extends { name: string; state?: WorkOwnerState }>(
  works: readonly T[],
  name: string,
): T | null {
  const live = works.filter((work) => work.state !== "deleted");
  const exact = live.filter((work) => work.name.toLowerCase() === name.trim().toLowerCase());
  if (exact.length === 1) return exact[0] ?? null;
  const key = workNameKey(name);
  const similar = key ? live.filter((work) => workNameKey(work.name) === key) : [];
  return similar.length === 1 ? (similar[0] ?? null) : null;
}

function chatLabel(title: string | null, detail: string): string {
  return `"${(title ?? "").replace(/\s+/g, " ").trim() || "New chat"}" (${detail})`;
}

export function createOwnerLookup(deps: OwnerLookupDeps): OwnerLookup {
  async function chat(projectId: string, ref: string): Promise<ChatFileAddresses | null> {
    const owner = await deps.chats.byRef(projectId, ref);
    if (!owner?.live) return null;
    const workHandle = (await deps.namedWorkHandle(owner.chatId)) as WorkHandle | null;
    const lineage = workHandle ? null : await deps.lineages.rootForThreadRef(projectId, ref);
    if (!workHandle && !lineage) return null;
    return {
      uploads: formatParsedContextUri("uploads", "", { kind: "chat", chatRef: owner.chatRef }),
      scratch: workHandle
        ? formatParsedContextUri("scratch", "", { kind: "work", workHandle })
        : formatParsedContextUri("scratch", "", {
            kind: "lineage",
            rootThreadRef: lineage?.rootThreadRef ?? "",
          }),
    };
  }
  return {
    chat,
    async subagent(projectId, ref) {
      const chatRef = await deps.subagentChatRef(projectId, ref);
      const files = chatRef ? await chat(projectId, chatRef) : null;
      return chatRef && files ? { ...files, chatRef } : null;
    },
    async work(projectId, handle) {
      return (await deps.works(projectId)).find((work) => work.handle === handle) ?? null;
    },
    async workNamed(projectId, name) {
      return findWorkNamed(await deps.works(projectId), name);
    },
    async scratchOwners(projectId) {
      const works = (await deps.works(projectId))
        .filter((work) => work.state !== "deleted")
        .map((work) => ({
          uri: formatParsedContextUri("scratch", "", { kind: "work", workHandle: work.handle }),
          label: work.state === "archived" ? `${work.name} (archived)` : work.name,
        }));
      const lineages = (await deps.lineages.list(projectId)).map((lineage) => ({
        uri: formatParsedContextUri("scratch", "", {
          kind: "lineage",
          rootThreadRef: lineage.rootThreadRef,
        }),
        label: chatLabel(lineage.title ?? null, `chat ${lineage.rootThreadRef}, No Work`),
      }));
      return [...works, ...lineages];
    },
    async uploadOwners(projectId) {
      return (await deps.chatsWithFiles(projectId)).map(({ chatRef, title }) => ({
        uri: formatParsedContextUri("uploads", "", { kind: "chat", chatRef }),
        label: chatLabel(title, `chat ${chatRef}`),
      }));
    },
  };
}

/** The lookup answering for one project, which is how a port's router asks. */
export interface ProjectOwners {
  chat(ref: string): Promise<ChatFileAddresses | null>;
  subagent(ref: string): Promise<(ChatFileAddresses & { chatRef: string }) | null>;
  work(handle: string): Promise<WorkOwner | null>;
  workNamed(name: string): Promise<WorkOwner | null>;
  scratchOwners(): Promise<OwnerRow[]>;
  uploadOwners(): Promise<OwnerRow[]>;
}

export function bindOwners(lookup: OwnerLookup, projectId: string): ProjectOwners {
  return {
    chat: (ref) => lookup.chat(projectId, ref),
    subagent: (ref) => lookup.subagent(projectId, ref),
    work: (handle) => lookup.work(projectId, handle),
    workNamed: (name) => lookup.workNamed(projectId, name),
    scratchOwners: () => lookup.scratchOwners(projectId),
    uploadOwners: () => lookup.uploadOwners(projectId),
  };
}

/** A lookup that knows no owners, for ports built without a database. */
export const emptyOwnerLookup: OwnerLookup = {
  chat: async () => null,
  subagent: async () => null,
  work: async () => null,
  workNamed: async () => null,
  scratchOwners: async () => [],
  uploadOwners: async () => [],
};
