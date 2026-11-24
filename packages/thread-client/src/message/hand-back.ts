import { type ProjectId, parseContextUri, type UserId, type WorkId } from "@meridian/contracts";
import type { UserMessageBlock } from "@meridian/contracts/protocol";
import {
  classifyFiletype,
  DEFAULT_FILETYPE,
  filetypeForExtension,
} from "@meridian/contracts/protocol";
import type { HandBackResult } from "@meridian/contracts/threads";
import type { WorkHandle } from "@meridian/contracts/works";
import { imageCapable as imageFile } from "./occurrences";
import type {
  BuiltMessageDoc,
  MessageDoc,
  MessageInlineNode,
  MessageParagraphNode,
  RestorableReference,
  StableReferenceAuthority,
} from "./types";

type RestorableDocumentReference = Extract<RestorableReference, { kind: "document" }>;
export type ReferenceFacts = Pick<RestorableDocumentReference, "fileType" | "authority">;
export type ResolveReference = (
  target: Pick<RestorableDocumentReference, "documentId" | "uri">,
) => ReferenceFacts | null;

export type ChatReferenceScope = {
  projectId: ProjectId;
  userId: UserId;
  work: { id: WorkId; handle: WorkHandle | null };
  rootThreadId: string;
  rootThreadRef: string | null;
  chatId: string;
  chatRef: string | null;
};

export function chatReferenceResolver(scope: ChatReferenceScope): ResolveReference {
  return ({ uri }) => {
    const parsed = parseContextUri(uri);
    if (!parsed.ok) return null;
    const name = parsed.value.path.split("/").at(-1) ?? "";
    const fileType = name.includes(".")
      ? filetypeForExtension(name.slice(name.lastIndexOf(".") + 1))
      : DEFAULT_FILETYPE;
    if (!fileType || classifyFiletype(fileType).kind === "unknown") return null;
    const { scheme, authority } = parsed.value;
    let owner: StableReferenceAuthority | null = null;
    if (authority.kind === "lineage") {
      if (scheme === "scratch" && scope.rootThreadRef === authority.rootThreadRef)
        owner = {
          kind: "lineage",
          projectId: scope.projectId,
          rootThreadId: scope.rootThreadId,
          rootThreadRef: authority.rootThreadRef,
        };
    } else if (authority.kind === "chat") {
      if (scheme === "uploads" && scope.chatRef === authority.chatRef)
        owner = {
          kind: "chat",
          projectId: scope.projectId,
          chatId: scope.chatId,
          chatRef: authority.chatRef,
        };
    } else if (authority.kind === "work") {
      if (scheme === "scratch" && authority.workHandle === scope.work.handle)
        owner = {
          kind: "work",
          projectId: scope.projectId,
          workId: scope.work.id,
          workHandle: scope.work.handle,
        };
    } else if (scheme !== "scratch" && scheme !== "uploads") {
      owner =
        scheme === "user"
          ? { kind: "user", userId: scope.userId }
          : { kind: "project", projectId: scope.projectId };
    }
    return owner && { fileType, authority: owner };
  };
}

function spelledLabel(text: string): string {
  if (!text.startsWith("[")) return text;
  let label = "";
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === "\\" && index + 1 < text.length) {
      index += 1;
      label += text[index];
    } else if (character === "]") return label;
    else label += character;
  }
  return text;
}

function uriName(uri: string): string {
  const last = uri.split(/[?#]/)[0]?.split("/").filter(Boolean).at(-1);
  return last || uri;
}

function paragraphsOf(
  blocks: readonly UserMessageBlock[],
  resolve: ResolveReference,
): MessageParagraphNode[] {
  const paragraphs: MessageInlineNode[][] = [[]];
  const inline = (node: MessageInlineNode) => paragraphs.at(-1)?.push(node);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as UserMessageBlock;
    if (block.type === "text") {
      block.text.split("\n").forEach((line, lineIndex) => {
        if (lineIndex) paragraphs.push([]);
        if (line) inline({ type: "text", text: line });
      });
    } else if (block.type === "skill") {
      inline({
        type: "composerSkill",
        attrs: { slug: block.slug, name: block.name, description: block.description },
      });
    } else if (block.type === "reference") {
      if (block.kind === "folder") {
        inline({
          type: "composerReference",
          attrs: {
            reference: {
              kind: "folder",
              folderId: block.folderId,
              uri: block.uri,
              label: spelledLabel(block.text),
            },
          },
        });
        continue;
      }
      const next = blocks[index + 1];
      const hasImage =
        next?.type === "image" && next.documentId === block.documentId && next.uri === block.uri;
      if (hasImage) index += 1;
      inline(chip(block, resolve, spelledLabel(block.text), hasImage) ?? textOf(block.text));
    } else {
      inline(chip(block, resolve, uriName(block.uri), true) ?? textOf(block.uri));
    }
  }
  return paragraphs.map((content) =>
    content.length ? { type: "paragraph", content } : { type: "paragraph" },
  );
}

const textOf = (text: string): MessageInlineNode => ({ type: "text", text });

function chip(
  target: Pick<RestorableDocumentReference, "documentId" | "uri">,
  resolve: ResolveReference,
  label: string,
  imageCapable: boolean,
): MessageInlineNode | null {
  const facts = resolve(target);
  if (!facts) return null;
  const known: ReferenceFacts =
    imageCapable && !imageFile(facts.fileType) ? { ...facts, fileType: "image" } : facts;
  return {
    type: "composerReference",
    attrs: {
      reference: {
        kind: "document",
        documentId: target.documentId,
        uri: target.uri,
        ...known,
        label,
        imageCapable,
        upload: null,
      },
    },
  };
}

export function composerDocFromHandedBack(
  handedBack: HandBackResult["handedBack"],
  resolve: ResolveReference,
): BuiltMessageDoc {
  const content: MessageParagraphNode[] = [];
  handedBack.forEach((message, index) => {
    if (index) content.push({ type: "paragraph" });
    content.push(...paragraphsOf(message.blocks, resolve));
  });
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function hasContent(node: MessageDoc): boolean {
  if (node.type === "text") return !!node.text;
  if (
    node.type === "composerSkill" ||
    node.type === "composerReference" ||
    node.type === "hardBreak"
  )
    return true;
  return (node.content ?? []).some(hasContent);
}

export function prependMessageDoc(returned: MessageDoc, current: MessageDoc | null): MessageDoc {
  const above = returned.content ?? [];
  if (!current || !hasContent(current)) return { type: "doc", content: above };
  return { type: "doc", content: [...above, { type: "paragraph" }, ...(current.content ?? [])] };
}
