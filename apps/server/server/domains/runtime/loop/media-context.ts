import { referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { TurnId } from "@meridian/contracts/runtime";
import type { Block, StoredMediaPart, Thread, ToolContentPart } from "@meridian/contracts/threads";
import { type MediaPart, type ModelInfo, placeMedia } from "@meridian-flow/runtime/gateway";
import type { MediaContextBreak } from "../../threads/index.js";
import {
  type LinkWindow,
  MediaResolutionError,
  type MediaResolverPort,
  type ResolvedMedia,
} from "../ports/media-resolver.js";

export const MAX_MODEL_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_MODEL_MEDIA_CONTEXT_BYTES = 20 * 1024 * 1024;
export const MEDIA_EVICTION_TARGET_BYTES = MAX_MODEL_MEDIA_CONTEXT_BYTES / 2;

export interface MediaInclusionDecision {
  blockId: string;
  partIndex: number;
  included: boolean;
  decidedByCompaction?: true;
}

export interface CompactionMediaProjectionMode {
  kind: "compaction";
  candidates: ReadonlySet<string>;
  decidingTurnId: TurnId;
}

export interface MediaContextProjection {
  blocks: Block[];
  decisions: MediaInclusionDecision[];
  breaks: MediaContextBreak[];
}

export type MediaModel = Pick<
  ModelInfo,
  "id" | "wire" | "inputModalities" | "maxLinkBytes" | "imageLinks" | "contextWindow"
>;

export function mediaUnitKey(blockId: string, partIndex: number): string {
  return `${blockId}\0${partIndex}`;
}

interface MediaUnit {
  partIndex: number;
  part: StoredMediaPart;
  inToolResult: boolean;
}

function isStoredMedia(value: unknown): value is StoredMediaPart {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "media" &&
    "ref" in (value as object)
  );
}

function toolResultParts(block: Block): ToolContentPart[] | null {
  if (block.blockType !== "tool_result") return null;
  const content = block.content as { content?: unknown } | null;
  return Array.isArray(content?.content) ? (content.content as ToolContentPart[]) : null;
}

const asBlockContent = (value: unknown) => value as Block["content"];

function referencedMedia(block: Block): StoredMediaPart | null {
  const reference = referenceOccurrenceContent(block);
  if (reference?.kind !== "document" || !reference.read) return null;
  const file = (reference.read.result as { file?: Record<string, unknown> } | null)?.file;
  return file?.given === "media"
    ? {
        type: "media",
        ref: { documentId: file.documentId as string, uri: file.uri as string },
        mediaType: file.mediaType as string,
        sizeBytes: file.sizeBytes as number,
        ...(typeof file.pageCount === "number" ? { pageCount: file.pageCount } : {}),
        name: file.name as string,
        ...(isChatCopy(file.chatCopy) ? { chatCopy: file.chatCopy } : {}),
      }
    : null;
}

function isChatCopy(value: unknown): value is { key: string } {
  return !!value && typeof (value as { key?: unknown }).key === "string";
}

export function mediaUnits(block: Block): MediaUnit[] {
  if (block.blockType === "media") {
    return isStoredMedia(block.content)
      ? [{ partIndex: 0, part: block.content, inToolResult: false }]
      : [];
  }
  const mentioned = referencedMedia(block);
  if (mentioned) return [{ partIndex: 0, part: mentioned, inToolResult: false }];
  return (toolResultParts(block) ?? []).flatMap((part, partIndex) =>
    isStoredMedia(part) ? [{ partIndex, part, inToolResult: true }] : [],
  );
}

type Chosen = { variant: "original" | "preview"; transport: "link" | "bytes"; sizeBytes: number };

function choose(
  model: MediaModel | null,
  file: ResolvedMedia,
  inToolResult: boolean,
  pages: number | undefined,
): Chosen | null {
  if (!model) return null;
  const flag = inToolResult ? ({ inToolResult: true } as const) : {};
  const original = placeMedia(model, {
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    ...(pages === undefined ? {} : { pages }),
    ...flag,
  });
  if (original.transport !== "none") {
    return { variant: "original", transport: original.transport, sizeBytes: file.sizeBytes };
  }
  if (!file.preview) return null;
  const preview = placeMedia(model, {
    mediaType: file.preview.mediaType,
    sizeBytes: file.preview.sizeBytes,
    ...flag,
  });
  return preview.transport !== "none"
    ? { variant: "preview", transport: preview.transport, sizeBytes: file.preview.sizeBytes }
    : null;
}

export function describeMedia(part: StoredMediaPart, why?: string): string {
  return `\n[${part.name}: ${part.mediaType}, ${part.sizeBytes} bytes${why ? `. ${why}` : ""}]`;
}

export async function projectMediaBlocksForModel(input: {
  thread: Pick<Thread, "id" | "projectId" | "userId">;
  blocks: readonly Block[];
  inclusions?: ReadonlyMap<string, boolean>;
  model: MediaModel | null;
  media: MediaResolverPort;
  window: LinkWindow;
  mode?: CompactionMediaProjectionMode;
  signal?: AbortSignal;
}): Promise<MediaContextProjection> {
  input.signal?.throwIfAborted();
  const context = {
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    actorUserId: input.thread.userId,
  };
  const reads = new Map<string, ResolvedMedia | null>();
  interface Entry {
    order: number;
    block: Block;
    unit: MediaUnit;
    file: ResolvedMedia;
    chosen: Chosen;
    included: boolean;
    reAdmissionCandidate: boolean;
  }
  const entries: Entry[] = [];
  const decisionByKey = new Map<string, MediaInclusionDecision>();
  const reAdmissionByKey = new Map<string, MediaInclusionDecision>();
  const descriptions = new Map<string, string>();
  const cantView = new Set<string>();
  const breaks: MediaContextBreak[] = [];
  let diagnosedOmission = false;
  const unavailableReason = (included: boolean | undefined) =>
    included === true ? "asset_unavailable" : "asset_unavailable_first_sight";
  const decide = (blockId: string, partIndex: number, included: boolean) =>
    decisionByKey.set(mediaUnitKey(blockId, partIndex), { blockId, partIndex, included });

  for (const block of input.blocks) {
    for (const unit of mediaUnits(block)) {
      input.signal?.throwIfAborted();
      const key = mediaUnitKey(block.id, unit.partIndex);
      const includedDecision = input.inclusions?.get(key);
      const reAdmissionCandidate =
        input.mode?.kind === "compaction" &&
        includedDecision === false &&
        input.mode.candidates.has(key);
      if (includedDecision === false && !reAdmissionCandidate) {
        descriptions.set(
          key,
          describeMedia(unit.part, "Removed from the request to fit the media budget."),
        );
        continue;
      }

      const readKey = `${unit.part.chatCopy?.key ?? ""}\0${unit.part.ref.documentId}\0${unit.part.ref.uri}`;
      let file = reads.get(readKey);
      if (file === undefined) {
        try {
          file = await input.media.resolve(context, unit.part, input.window);
        } catch (error) {
          if (!reAdmissionCandidate || !(error instanceof MediaResolutionError)) throw error;
          input.signal?.throwIfAborted();
          continue;
        }
        input.signal?.throwIfAborted();
        reads.set(readKey, file);
      }

      if (!file || !Number.isFinite(file.sizeBytes) || file.sizeBytes < 0) {
        if (reAdmissionCandidate) {
          if (file) throw new Error("Media resolver returned an invalid size");
          continue;
        }
        decide(block.id, unit.partIndex, false);
        descriptions.set(key, describeMedia(unit.part, "No longer available."));
        breaks.push({
          blockId: block.id,
          uri: unit.part.ref.uri,
          mediaType: unit.part.mediaType,
          reason: unavailableReason(includedDecision),
        });
        diagnosedOmission = true;
        continue;
      }

      const chosen = choose(input.model, file, unit.inToolResult, unit.part.pageCount);
      if (!chosen) {
        descriptions.set(key, describeMedia(unit.part, "This model can't view it."));
        cantView.add(key);
        continue;
      }
      entries.push({
        order: entries.length,
        block,
        unit,
        file,
        chosen,
        included: includedDecision === true,
        reAdmissionCandidate,
      });
    }
  }

  const entryOf = (entry: Entry) => mediaUnitKey(entry.block.id, entry.unit.partIndex);

  let usedBytes = entries.reduce((sum, e) => sum + (e.included ? e.chosen.sizeBytes : 0), 0);
  const evict = (entry: Entry) => {
    entry.included = false;
    usedBytes -= entry.chosen.sizeBytes;
    decide(entry.block.id, entry.unit.partIndex, false);
    descriptions.set(
      entryOf(entry),
      describeMedia(entry.unit.part, "Removed from the request to fit the media budget."),
    );
    breaks.push({
      blockId: entry.block.id,
      uri: entry.unit.part.ref.uri,
      mediaType: entry.unit.part.mediaType,
      reason: "budget_eviction",
    });
  };
  for (const entry of entries) {
    if (entry.included && entry.chosen.sizeBytes > MAX_MODEL_MEDIA_BYTES) evict(entry);
  }

  for (const entry of entries) {
    if (entry.reAdmissionCandidate) continue;
    if (input.inclusions?.get(entryOf(entry)) === true) continue;
    const omit = () => {
      decide(entry.block.id, entry.unit.partIndex, false);
      descriptions.set(
        entryOf(entry),
        describeMedia(entry.unit.part, "Not included: it is over the media budget."),
      );
      diagnosedOmission = true;
    };
    if (entry.chosen.sizeBytes > MAX_MODEL_MEDIA_BYTES) {
      omit();
      continue;
    }
    if (usedBytes + entry.chosen.sizeBytes > MAX_MODEL_MEDIA_CONTEXT_BYTES) {
      while (usedBytes + entry.chosen.sizeBytes > MEDIA_EVICTION_TARGET_BYTES) {
        const oldest = entries.find(
          (candidate) =>
            candidate.included && !candidate.reAdmissionCandidate && candidate.order < entry.order,
        );
        if (!oldest) break;
        evict(oldest);
      }
    }
    if (usedBytes + entry.chosen.sizeBytes > MAX_MODEL_MEDIA_CONTEXT_BYTES) {
      omit();
      continue;
    }
    entry.included = true;
    usedBytes += entry.chosen.sizeBytes;
    decide(entry.block.id, entry.unit.partIndex, true);
  }

  for (const entry of entries
    .filter((candidate) => candidate.reAdmissionCandidate)
    .sort((left, right) => right.order - left.order)) {
    if (entry.chosen.sizeBytes > MAX_MODEL_MEDIA_BYTES) continue;
    if (usedBytes + entry.chosen.sizeBytes > MAX_MODEL_MEDIA_CONTEXT_BYTES) continue;
    entry.included = true;
    usedBytes += entry.chosen.sizeBytes;
    reAdmissionByKey.set(entryOf(entry), {
      blockId: entry.block.id,
      partIndex: entry.unit.partIndex,
      included: true,
      decidedByCompaction: true,
    });
  }
  for (const entry of entries) {
    if (!entry.included) {
      const key = entryOf(entry);
      if (!descriptions.has(key))
        descriptions.set(
          key,
          describeMedia(entry.unit.part, "Removed from the request to fit the media budget."),
        );
    }
  }

  const sent = new Map<string, MediaPart>();
  await Promise.all(
    entries
      .filter((entry) => entry.included)
      .map(async (entry) => {
        const source = await entry.file.source(entry.chosen.variant, entry.chosen.transport);
        input.signal?.throwIfAborted();
        if (!source) {
          entry.included = false;
          if (entry.reAdmissionCandidate) {
            reAdmissionByKey.delete(entryOf(entry));
            return;
          }
          decide(entry.block.id, entry.unit.partIndex, false);
          descriptions.set(entryOf(entry), describeMedia(entry.unit.part, "No longer available."));
          breaks.push({
            blockId: entry.block.id,
            uri: entry.unit.part.ref.uri,
            mediaType: entry.unit.part.mediaType,
            reason: unavailableReason(input.inclusions?.get(entryOf(entry))),
          });
          diagnosedOmission = true;
          return;
        }
        const mediaType =
          entry.chosen.variant === "preview" && entry.file.preview
            ? entry.file.preview.mediaType
            : entry.file.mediaType;
        sent.set(entryOf(entry), {
          type: "media",
          mediaType,
          filename: entry.unit.part.name,
          ...(entry.unit.part.pageCount === undefined
            ? {}
            : { pageCount: entry.unit.part.pageCount }),
          source,
        });
      }),
  );

  if (diagnosedOmission) {
    input.media.diagnose?.({
      threadId: input.thread.id,
      projectId: input.thread.projectId,
      reason: "unavailable_or_over_budget",
    });
  }

  const blocks = input.blocks.flatMap((block): Block[] => {
    const units = mediaUnits(block);
    if (units.length === 0) return [block];
    if (block.blockType === "media") {
      const key = mediaUnitKey(block.id, 0);
      const part = sent.get(key);
      if (part) return [{ ...block, content: asBlockContent(part) }];
      const description = cantView.has(key) ? descriptions.get(key) : undefined;
      return description
        ? [{ ...block, blockType: "text", textContent: description, content: description }]
        : [];
    }
    const reference = referenceOccurrenceContent(block);
    if (reference?.kind === "document" && reference.read) {
      const key = mediaUnitKey(block.id, 0);
      const shown = sent.get(key) ?? descriptions.get(key);
      return [
        shown === undefined
          ? block
          : {
              ...block,
              content: asBlockContent({ ...reference, read: { ...reference.read, media: shown } }),
            },
      ];
    }
    const parts = toolResultParts(block) ?? [];
    return [
      {
        ...block,
        content: asBlockContent({
          ...(block.content as object),
          content: parts.map((part, partIndex) => {
            const key = mediaUnitKey(block.id, partIndex);
            const description = descriptions.get(key);
            return (
              sent.get(key) ??
              (description === undefined ? part : { type: "text", text: description })
            );
          }),
        }),
      },
    ];
  });

  return {
    blocks,
    decisions:
      input.mode?.kind === "compaction"
        ? [...reAdmissionByKey.values(), ...decisionByKey.values()]
        : [...decisionByKey.values()],
    breaks,
  };
}
