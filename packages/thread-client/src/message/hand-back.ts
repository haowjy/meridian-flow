/**
 * The composer content a hand-back returns, built in the package so the app and `./mf` agree.
 *
 * `composerDocFromHandedBack` is the inverse of `serializeMessageDoc` over every
 * `UserMessageBlock` shape: serializing its document again gives the blocks that were handed
 * back. `prependMessageDoc` puts that document above what the writer has typed.
 */
import { type ProjectId, parseContextUri, type UserId, type WorkId } from "@meridian/contracts";
import type { UserMessageBlock } from "@meridian/contracts/protocol";
import {
  classifyFiletype,
  DEFAULT_FILETYPE,
  filetypeForExtension,
} from "@meridian/contracts/protocol";
import type { HandBackResult } from "@meridian/contracts/threads";
import type { WorkSlug } from "@meridian/contracts/works";
import type {
  BuiltMessageDoc,
  MessageDoc,
  MessageInlineNode,
  MessageParagraphNode,
  RestorableReference,
  StableReferenceAuthority,
} from "./types";

/** What a reference chip needs beyond the occurrence the server kept. */
export type ReferenceFacts = Pick<RestorableReference, "fileType" | "authority">;
export type ResolveReference = (
  target: Pick<RestorableReference, "documentId" | "uri">,
) => ReferenceFacts | null;

/** The chat's own place: the owners its handed-back references can name. */
export type ChatReferenceScope = {
  projectId: ProjectId;
  userId: UserId;
  work: { id: WorkId; slug: WorkSlug | null };
  /** The lineage's first chat, which owns a No Work chat's Scratch. */
  rootThreadId: string;
};

/**
 * Resolve a handed-back reference from its URI and the chat it came from. The occurrence keeps
 * only the document and URI, so the owner is read off the URI's authority; a URI outside the
 * chat's own owners resolves to nothing and comes back as its link text.
 */
export function chatReferenceResolver(scope: ChatReferenceScope): ResolveReference {
  return ({ uri }) => {
    const parsed = parseContextUri(uri);
    if (!parsed.ok) return null;
    // The URI is all the occurrence keeps: a name with no extension is a document of the default
    // type, and an extension nothing registers resolves to nothing.
    const name = parsed.value.path.split("/").at(-1) ?? "";
    const fileType = name.includes(".")
      ? filetypeForExtension(name.slice(name.lastIndexOf(".") + 1))
      : DEFAULT_FILETYPE;
    if (!fileType || classifyFiletype(fileType).kind === "unknown") return null;
    const { scheme, authority } = parsed.value;
    let owner: StableReferenceAuthority | null = null;
    if (authority.kind === "lineage") {
      if (scheme === "scratch")
        owner = {
          kind: "lineage",
          projectId: scope.projectId,
          rootThreadId: scope.rootThreadId,
          rootThreadRef: authority.rootThreadRef,
        };
    } else if (authority.kind === "none") {
      if (scope.work.slug === null)
        owner = { kind: "work", projectId: scope.projectId, workId: scope.work.id, workSlug: null };
    } else if (authority.kind === "work") {
      if (authority.workSlug === scope.work.slug)
        owner = {
          kind: "work",
          projectId: scope.projectId,
          workId: scope.work.id,
          workSlug: scope.work.slug,
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

/** The label of a `[label](destination)` spelling, undoing `formatMarkdownLink`'s escapes. */
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

/** A name for an image whose reference chip the sender never had (only an API client sends one). */
function uriName(uri: string): string {
  const last = uri.split(/[?#]/)[0]?.split("/").filter(Boolean).at(-1);
  return last || uri;
}

/** One message's paragraphs: a newline in text starts a new paragraph. */
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
      // The serializer makes an image block right after an image-capable chip, so the chip
      // makes it again on send: that block is consumed here.
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

/** A reference chip, or null when the chat can't say who owns the document. */
function chip(
  target: Pick<RestorableReference, "documentId" | "uri">,
  resolve: ResolveReference,
  label: string,
  imageCapable: boolean,
): MessageInlineNode | null {
  const facts = resolve(target);
  if (!facts) return null;
  // The upload was adopted at admission, so it is an ordinary document now.
  return {
    type: "composerReference",
    attrs: {
      reference: {
        documentId: target.documentId,
        uri: target.uri,
        ...facts,
        label,
        imageCapable,
        upload: null,
      },
    },
  };
}

/**
 * The messages in send order, one empty paragraph between each, as one editable composer
 * document: no card or block wraps it.
 */
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

/**
 * The returned document above what is typed, with one empty paragraph between, keeping every
 * typed node. A composer with nothing typed gives just the returned document.
 */
export function prependMessageDoc(returned: MessageDoc, current: MessageDoc | null): MessageDoc {
  const above = returned.content ?? [];
  if (!current || !hasContent(current)) return { type: "doc", content: above };
  return { type: "doc", content: [...above, { type: "paragraph" }, ...(current.content ?? [])] };
}
