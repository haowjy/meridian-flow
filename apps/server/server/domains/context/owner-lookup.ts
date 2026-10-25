/**
 * The one component that interprets an owner spelling: who a handle or near-miss name stands for
 * in the caller's project, and what to tell the model about it (deleted Works, name and handle
 * collisions, dropped sigils, handle-shaped names, subagent handles). The router, the receipt
 * notice, the thread tools and the `work` tool all consume its answers, so they name only
 * addresses that resolve and show each handle beside its label.
 *
 * Storage questions are narrow: a handle is one indexed `(project_id, handle)` read and a name is
 * one bounded read. Only discovery (`ls scratch://@`) lists every Work. Policy authorization is a
 * separate concern and never lives here.
 */
import {
  formatParsedContextUri,
  type OwnedContextUriScheme,
  type OwnerSlip,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import { classifyHandleToken, type WorkHandle } from "@meridian/contracts/handles";
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

/** An address note for a receipt: a sentence to print on its own line, or the owner's label. */
export type OwnerReceiptNote = { notice: string } | { owner: string };

/** The one error for a Work handle that names no Work. It points to `work list` instead of listing. */
export function unknownWorkMessage(handle: string): string {
  return `Unknown Work ${handle}. Use work list.`;
}

/** The owner the caller's own port supplies for a concrete no-handle repair. */
export interface ContextualOwner {
  kind: "work" | "chat";
  handle: string;
}

/** A Work handle or name the `work` tool copied: the Work it reaches, or what to say instead. */
export type WorkReference = { ok: true; work: WorkOwner } | { ok: false; message: string };

export interface OwnerLookup {
  /** A live chat of `projectId` by its `c` handle: where its files are. Null for anything else. */
  chat(projectId: string, ref: string): Promise<ChatFileAddresses | null>;
  /** Why a Work handle reaches nothing: unknown, or deleted and perhaps still restorable. */
  unknownWork(projectId: string, handle: string): Promise<string>;
  /** A near-miss owner spelling answered with the real owner; `fallback` is the lookup-free answer. */
  slipReason(
    projectId: string,
    slip: OwnerSlip,
    fallback: string,
    own: ContextualOwner | null,
  ): Promise<string>;
  /** The Work a handle names (deleted ones included), or the handle its name answers to. */
  workReference(projectId: string, ref: string): Promise<WorkReference>;
  /**
   * What a read or write result says about its address: a collision or dropped-sigil `notice` (its
   * own line), else, for an explicit owner address, the owner's current `owner` label (the receipt
   * puts it in parentheses after the path). Null for bare addresses.
   */
  notice(
    projectId: string,
    requestedPath: string,
    canonicalUri: string,
  ): Promise<OwnerReceiptNote | null>;
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
  /** One Work by handle, deleted ones included: the indexed `(project_id, handle)` read. */
  workByHandle(projectId: string, handle: string): Promise<WorkOwner | null>;
  /** The few non-deleted Works whose name equals or collapses to `name`; a bounded read. */
  worksNamed(projectId: string, name: string): Promise<WorkOwner[]>;
  /** Every non-deleted Work of the project: discovery only. */
  listWorks(projectId: string): Promise<WorkOwner[]>;
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

function chatTitle(title: string | null): string {
  return `"${(title ?? "").replace(/\s+/g, " ").trim() || "New chat"}"`;
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
  async function subagentFiles(projectId: string, ref: string) {
    const chatRef = await deps.subagentChatRef(projectId, ref);
    const files = chatRef ? await chat(projectId, chatRef) : null;
    return chatRef && files ? { ...files, chatRef } : null;
  }

  async function workNamed(projectId: string, name: string): Promise<WorkOwner | null> {
    return findWorkNamed(await deps.worksNamed(projectId, name), name);
  }

  async function unknownWork(projectId: string, handle: string): Promise<string> {
    const owner = await deps.workByHandle(projectId, handle);
    if (owner?.state !== "deleted") return unknownWorkMessage(handle);
    return owner.restorableDays === null
      ? `Work ${handle} was deleted.`
      : `Work ${handle} was deleted; restorable for ${owner.restorableDays} ${owner.restorableDays === 1 ? "day" : "days"}.`;
  }

  async function slipReason(
    projectId: string,
    slip: OwnerSlip,
    fallback: string,
    own: ContextualOwner | null,
  ): Promise<string> {
    const owned = (
      scheme: OwnedContextUriScheme,
      authority: Parameters<typeof formatParsedContextUri>[2],
    ) => formatParsedContextUri(scheme, "", authority);
    switch (slip.kind) {
      case "name": {
        const work = await workNamed(projectId, slip.token);
        return work
          ? `Use ${owned("scratch", { kind: "work", workHandle: work.handle })}… (Work "${work.name}").`
          : fallback;
      }
      case "subagent": {
        const subagent = await subagentFiles(projectId, slip.token);
        if (!subagent) return fallback;
        return slip.scheme === "uploads"
          ? `${slip.token}'s chat uploads: ${subagent.uploads}…`
          : `${slip.token}'s notes: ${subagent.scratch}…`;
      }
      case "uppercase": {
        if (slip.scheme !== "scratch") return fallback;
        const named = await workNamed(projectId, slip.token);
        const lower = classifyHandleToken(slip.token.toLowerCase());
        const lowerWork =
          lower.kind === "handle" && lower.handle.kind === "work"
            ? await deps.workByHandle(projectId, lower.handle.handle)
            : null;
        const both =
          named && lowerWork && lowerWork.state !== "deleted"
            ? ` ${lowerWork.handle} is "${lowerWork.name}"; "${slip.token}" is ${named.handle}.`
            : named
              ? ` Work "${slip.token}" is ${named.handle}.`
              : "";
        return `${fallback}${both}`;
      }
      case "no-handle": {
        if (!own) return fallback;
        if (slip.scheme === "uploads") {
          return `This chat: ${owned("uploads", { kind: "chat", chatRef: own.handle })}… . Other chats: ls uploads://@.`;
        }
        const address =
          own.kind === "work"
            ? owned("scratch", { kind: "work", workHandle: own.handle as WorkHandle })
            : owned("scratch", { kind: "lineage", rootThreadRef: own.handle });
        return `${own.kind === "work" ? "This Work" : "This chat's lineage"}: ${address}… . Other owners: ls scratch://@.`;
      }
    }
  }

  async function notice(
    projectId: string,
    requestedPath: string,
  ): Promise<OwnerReceiptNote | null> {
    const requested = parseUnifiedContextUri(requestedPath.replace(/#.*$/, ""));
    if (!requested.ok) return null;
    const { authority, path } = requested.value;
    if (requested.value.scheme === "uploads") {
      if (authority.kind !== "chat") return null;
      const owner = await deps.chats.byRef(projectId, authority.chatRef);
      return owner?.live ? { owner: `chat ${chatTitle(owner.title ?? null)}` } : null;
    }
    if (requested.value.scheme !== "scratch") return null;
    const workAddress = (handle: string) =>
      formatParsedContextUri("scratch", "", { kind: "work", workHandle: handle as WorkHandle });

    if (authority.kind === "work" || authority.kind === "lineage") {
      const handle = authority.kind === "work" ? authority.workHandle : authority.rootThreadRef;
      const named = await workNamed(projectId, handle);
      // No collision: the receipt still names the owner beside the path.
      if (!named || named.handle === handle) {
        if (authority.kind === "work") {
          const work = await deps.workByHandle(projectId, handle);
          return work && work.state !== "deleted" ? { owner: `Work "${work.name}"` } : null;
        }
        const lineage = await deps.lineages.byRef(projectId, handle);
        return lineage ? { owner: `chat ${chatTitle(lineage.title ?? null)}` } : null;
      }
      // Measured on deepseek-flash: without the reached address and "is w3", the
      // model read this as an alias and wrote to the handle anyway (6/6).
      const address = formatParsedContextUri("scratch", "", authority);
      const reached =
        authority.kind === "work"
          ? `Work ${handle} "${(await deps.workByHandle(projectId, handle))?.name ?? ""}"`
          : `chat ${handle}'s notes`;
      return {
        notice: `${address} is ${reached}. The Work named "${handle}" is ${named.handle} at ${workAddress(named.handle)}… .`,
      };
    }

    if (authority.kind !== "contextual") return null;
    const first = classifyHandleToken(path.split("/")[0] ?? "");
    if (first.kind !== "handle") return null;
    const { handle, kind } = first.handle;
    if (kind === "work") {
      const work = await deps.workByHandle(projectId, handle);
      if (!work || work.state === "deleted") return null;
      return {
        notice: `${handle} is a folder in this chat's notes. Work "${work.name}": ${workAddress(handle)}… .`,
      };
    }
    if (kind === "chat") {
      const files = await chat(projectId, handle);
      if (!files) return null;
      return {
        notice: `${handle} is a folder in this chat's notes. Chat ${handle}'s notes: ${files.scratch}… .`,
      };
    }
    return null;
  }

  return {
    chat,
    unknownWork,
    slipReason,
    async workReference(projectId, ref) {
      const work = await deps.workByHandle(projectId, ref);
      if (work) return { ok: true, work };
      const named = await workNamed(projectId, ref);
      return {
        ok: false,
        message: named ? `"${named.name}" is ${named.handle}.` : unknownWorkMessage(ref),
      };
    },
    notice,
    async scratchOwners(projectId) {
      const works = (await deps.listWorks(projectId)).map((work) => ({
        uri: formatParsedContextUri("scratch", "", { kind: "work", workHandle: work.handle }),
        label: work.state === "archived" ? `${work.name} (archived)` : work.name,
      }));
      const lineages = (await deps.lineages.list(projectId)).map((lineage) => ({
        uri: formatParsedContextUri("scratch", "", {
          kind: "lineage",
          rootThreadRef: lineage.rootThreadRef,
        }),
        label: chatTitle(lineage.title ?? null),
      }));
      return [...works, ...lineages];
    },
    async uploadOwners(projectId) {
      return (await deps.chatsWithFiles(projectId)).map(({ chatRef, title }) => ({
        uri: formatParsedContextUri("uploads", "", { kind: "chat", chatRef }),
        label: chatTitle(title),
      }));
    },
  };
}

/** The lookup answering for one project, which is how a port's router asks. */
export interface ProjectOwners {
  chat(ref: string): Promise<ChatFileAddresses | null>;
  unknownWork(handle: string): Promise<string>;
  slipReason(slip: OwnerSlip, fallback: string, own: ContextualOwner | null): Promise<string>;
  scratchOwners(): Promise<OwnerRow[]>;
  uploadOwners(): Promise<OwnerRow[]>;
}

export function bindOwners(lookup: OwnerLookup, projectId: string): ProjectOwners {
  return {
    chat: (ref) => lookup.chat(projectId, ref),
    unknownWork: (handle) => lookup.unknownWork(projectId, handle),
    slipReason: (slip, fallback, own) => lookup.slipReason(projectId, slip, fallback, own),
    scratchOwners: () => lookup.scratchOwners(projectId),
    uploadOwners: () => lookup.uploadOwners(projectId),
  };
}

/** A lookup that knows no owners, for ports built without a database. */
export const emptyOwnerLookup: OwnerLookup = {
  chat: async () => null,
  unknownWork: async (_projectId, handle) => unknownWorkMessage(handle),
  slipReason: async (_projectId, _slip, fallback) => fallback,
  workReference: async (_projectId, ref) => ({ ok: false, message: unknownWorkMessage(ref) }),
  notice: async () => null,
  scratchOwners: async () => [],
  uploadOwners: async () => [],
};
