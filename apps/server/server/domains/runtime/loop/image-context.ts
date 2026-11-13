/**
 * Stable request-time projection of durable media occurrences: a writer's pictures and the media
 * in tool results. Each occurrence is a unit, `(blockId, partIndex)`, because one tool result can
 * hold several. Decisions persist per unit; the gateway's parts are made last, so a unit that is
 * not sent costs no link and no read.
 */

import { referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { TurnId } from "@meridian/contracts/runtime";
import type { Block, StoredMediaPart, Thread, ToolContentPart } from "@meridian/contracts/threads";
import { type MediaPart, type ModelInfo, placeMedia } from "@meridian-flow/gateway";
import type { ImageContextBreak } from "../../threads/index.js";
import {
  type LinkWindow,
  MediaResolutionError,
  type MediaResolverPort,
  type ResolvedMedia,
} from "../ports/media-resolver.js";

export const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MODEL_IMAGE_CONTEXT_BYTES = 20 * 1024 * 1024;
/**
 * When the budget forces eviction, the oldest media go until this much is left, so the next
 * several arrivals fit without moving the cached prefix again.
 */
export const MEDIA_EVICTION_TARGET_BYTES = MAX_MODEL_IMAGE_CONTEXT_BYTES / 2;

export interface ImageInclusionDecision {
  blockId: string;
  partIndex: number;
  included: boolean;
  decidedByCompaction?: true;
}

export interface CompactionImageProjectionMode {
  kind: "compaction";
  /** `mediaUnitKey` of every unit the compaction may re-admit. */
  candidates: ReadonlySet<string>;
  decidingTurnId: TurnId;
}

export interface ImageContextProjection {
  blocks: Block[];
  decisions: ImageInclusionDecision[];
  breaks: ImageContextBreak[];
}

export type MediaModel = Pick<
  ModelInfo,
  "id" | "wire" | "inputModalities" | "maxLinkBytes" | "imageLinks"
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

/** The gateway's part, held in a block's JSON content for the one request it is built for. */
const asBlockContent = (value: unknown) => value as Block["content"];

/** The file a mention's read decided to show the model as media: the read result names it. */
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
        name: file.name as string,
      }
    : null;
}

/**
 * The media a block holds: a writer's picture, or a file they mentioned that was shown as media,
 * is its one unit; a tool result's media are its parts.
 */
export function mediaUnits(block: Block): MediaUnit[] {
  if (block.blockType === "image") {
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

/** What to send for this file to this model, or null when the model can't take it at all. */
function choose(
  model: MediaModel | null,
  file: ResolvedMedia,
  inToolResult: boolean,
): Chosen | null {
  if (!model) return null;
  const flag = inToolResult ? ({ inToolResult: true } as const) : {};
  const original = placeMedia(model, {
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
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

/**
 * A media part as text. It starts on its own line because the text part before it is joined to
 * it without a separator when the request is mapped.
 */
export function describeMedia(part: StoredMediaPart, why?: string): string {
  return `\n[${part.name}: ${part.mediaType}, ${part.sizeBytes} bytes${why ? `. ${why}` : ""}]`;
}

/**
 * Project stable media decisions and named breaks; a compaction can fill free budget by
 * re-admitting excluded media without changing any existing inclusion.
 */
export async function projectImageBlocksForModel(input: {
  thread: Pick<Thread, "id" | "projectId" | "userId">;
  blocks: readonly Block[];
  /** Saved decisions by `mediaUnitKey`. */
  inclusions?: ReadonlyMap<string, boolean>;
  model: MediaModel | null;
  media: MediaResolverPort;
  window: LinkWindow;
  mode?: CompactionImageProjectionMode;
  signal?: AbortSignal;
}): Promise<ImageContextProjection> {
  input.signal?.throwIfAborted();
  const context = {
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    actorUserId: input.thread.userId,
  };
  const reads = new Map<string, ResolvedMedia | null>();
  interface Entry {
    index: number;
    block: Block;
    unit: MediaUnit;
    file: ResolvedMedia;
    chosen: Chosen;
    included: boolean;
    reAdmissionCandidate: boolean;
  }
  const entries: Entry[] = [];
  const decisionByKey = new Map<string, ImageInclusionDecision>();
  const reAdmissionByKey = new Map<string, ImageInclusionDecision>();
  /** Text that stands in for a unit that is not sent, by unit key. */
  const descriptions = new Map<string, string>();
  /** Units whose model can't take them: a picture the writer attached is then described, not dropped. */
  const cantView = new Set<string>();
  const breaks: ImageContextBreak[] = [];
  let diagnosedOmission = false;
  const unavailableReason = (included: boolean | undefined) =>
    included === true ? "asset_unavailable" : "asset_unavailable_first_sight";
  const decide = (blockId: string, partIndex: number, included: boolean) =>
    decisionByKey.set(mediaUnitKey(blockId, partIndex), { blockId, partIndex, included });

  for (const [index, block] of input.blocks.entries()) {
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

      const readKey = `${unit.part.ref.documentId}\0${unit.part.ref.uri}`;
      let file = reads.get(readKey);
      if (file === undefined) {
        try {
          file = await input.media.resolve(context, unit.part.ref, input.window);
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

      const chosen = choose(input.model, file, unit.inToolResult);
      if (!chosen) {
        // The model can't take this file: say so, and keep it out of the saved decisions, since
        // switching models changes the answer.
        descriptions.set(key, describeMedia(unit.part, "This model can't view it."));
        cantView.add(key);
        continue;
      }
      entries.push({
        index,
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

  // Previously included media own the current prefix. Only newly carried media may evict them.
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
    if (entry.included && entry.chosen.sizeBytes > MAX_MODEL_IMAGE_BYTES) evict(entry);
  }

  // New arrivals keep the chronological eviction rule. A re-admission candidate that did not fit
  // never evicts anything.
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
    if (entry.chosen.sizeBytes > MAX_MODEL_IMAGE_BYTES) {
      omit();
      continue;
    }
    if (usedBytes + entry.chosen.sizeBytes > MAX_MODEL_IMAGE_CONTEXT_BYTES) {
      // Evict a chunk, not one: every eviction moves the cached prefix.
      while (usedBytes + entry.chosen.sizeBytes > MEDIA_EVICTION_TARGET_BYTES) {
        const oldest = entries.find(
          (candidate) =>
            candidate.included && !candidate.reAdmissionCandidate && candidate.index < entry.index,
        );
        if (!oldest) break;
        evict(oldest);
      }
    }
    if (usedBytes + entry.chosen.sizeBytes > MAX_MODEL_IMAGE_CONTEXT_BYTES) {
      omit();
      continue;
    }
    entry.included = true;
    usedBytes += entry.chosen.sizeBytes;
    decide(entry.block.id, entry.unit.partIndex, true);
  }

  // Compaction candidates only claim budget left after normal late-arrival handling.
  for (const entry of entries
    .filter((candidate) => candidate.reAdmissionCandidate)
    .sort((left, right) => right.index - left.index)) {
    if (entry.chosen.sizeBytes > MAX_MODEL_IMAGE_BYTES) continue;
    if (usedBytes + entry.chosen.sizeBytes > MAX_MODEL_IMAGE_CONTEXT_BYTES) continue;
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

  // Only now is any link signed or any byte read, and only for what is sent.
  const sent = new Map<string, MediaPart>();
  await Promise.all(
    entries
      .filter((entry) => entry.included)
      .map(async (entry) => {
        const source = await entry.file.source(entry.chosen.variant, entry.chosen.transport);
        input.signal?.throwIfAborted();
        const mediaType =
          entry.chosen.variant === "preview" && entry.file.preview
            ? entry.file.preview.mediaType
            : entry.file.mediaType;
        sent.set(entryOf(entry), {
          type: "media",
          mediaType,
          filename: entry.unit.part.name,
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
    if (block.blockType === "image") {
      const key = mediaUnitKey(block.id, 0);
      const part = sent.get(key);
      if (part) return [{ ...block, content: asBlockContent(part) }];
      // A picture the budget removed has its removal notice already; one the model can't take is described.
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
