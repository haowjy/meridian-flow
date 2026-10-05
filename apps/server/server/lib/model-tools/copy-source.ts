/**
 * A write's `from` (D38): resolving and reading a copy's source with `read`'s
 * version rule (D14) and the source's own destination (D20), and the binary
 * copy that duplicates a stored object (D24).
 */
import type {
  DocumentVersion,
  WriteOutcome,
  WriteToolInput,
} from "@meridian/agent-edit/integration";
import {
  documentNotFoundMessage,
  modelResult,
  splitDocumentFile,
} from "@meridian/agent-edit/integration";
import { copyBinaryDocument } from "../../domains/context/binary-copy.js";
import type { CopiedFrom } from "../../domains/context/document-metadata.js";
import type { BinaryFileRef, FileRef } from "../../domains/context/ports/context-port.js";
import type { FileGrant, Principal } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { documentGrant } from "./file-access.js";
import { type ReadSelection, readDocument } from "./read-document.js";
import {
  contextErrorMessage,
  isToolError,
  type ResolvedDocumentAddress,
  type ResolvedModelContextPort,
  recordTouchInBackground,
  resolveContextPort,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";

/** `from` on `insert`, `replace` or `copy`. */
export type CopySource = { path: string; in?: ReadSelection["in"]; version?: DocumentVersion };

/** A tracked source read for a copy: its blocks and what `metadata.copiedFrom` records. */
export interface CopiedSource {
  nodes: NonNullable<WriteOutcome["nodes"]>;
  copiedFrom: CopiedFrom;
}

/**
 * Reads a copy's source through `readDocument`, with `read`'s version rule
 * (D14) and the source's own destination (D20).
 */
export async function readCopySource(
  deps: ToolWiringDeps,
  principal: Principal,
  command: "insert" | "replace" | "copy",
  source: CopySource,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseId">,
): Promise<CopiedSource | WriteToolErrorOutput> {
  const resolved = await resolveCopySource(deps, command, source, ctx);
  if (isToolError(resolved)) return resolved;
  if (resolved.ref.kind !== "tracked") {
    return writeToolError(
      command,
      fromMessage(source, "The file is binary, so its blocks can't be copied."),
      "binary_file",
    );
  }
  return readTrackedCopySource(deps, principal, command, source, resolved.address, ctx);
}

export async function resolveCopySource(
  deps: ToolWiringDeps,
  command: "insert" | "replace" | "copy",
  source: CopySource,
  ctx: Pick<ToolHandlerContext, "threadId" | "responseId">,
): Promise<{ ref: FileRef; address: ResolvedDocumentAddress } | WriteToolErrorOutput> {
  // A live source resolves its path against live membership, as a live read does.
  const context = await resolveContextPort(deps, ctx.threadId, ctx.responseId, source.version);
  if (isToolError(context))
    return writeToolError(command, fromMessage(source, context.output.message));
  const { filePath: basePath, fragment } = splitDocumentFile(source.path);
  const ref = await context.port.stat(basePath);
  if (!ref.ok) {
    if (ref.error.code === "not_found") {
      return writeToolError(
        command,
        fromMessage(source, documentNotFoundMessage(command)),
        "document_not_found",
      );
    }
    return writeToolError(command, fromMessage(source, contextErrorMessage(ref.error)));
  }
  if (ref.value.kind === "tracked" && !ref.value.documentId) {
    return writeToolError(command, fromMessage(source, "Document id missing."));
  }
  return {
    ref: ref.value,
    address: {
      documentId: ref.value.documentId ?? "",
      uri: ref.value.uri,
      filePath: basePath,
      ...(fragment === undefined ? {} : { fragment }),
    },
  };
}

export async function readTrackedCopySource(
  deps: ToolWiringDeps,
  principal: Principal,
  command: "insert" | "replace" | "copy",
  source: CopySource,
  address: ResolvedDocumentAddress,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseId">,
): Promise<CopiedSource | WriteToolErrorOutput> {
  const grant = await documentGrant(deps, principal, command, address, "read");
  if (isToolError(grant)) {
    return writeToolError(command, fromMessage(source, grant.output.message ?? ""));
  }
  const outcome = await readDocument(
    deps,
    grant,
    address,
    {
      ...(source.in !== undefined ? { selection: { in: source.in } } : {}),
      ...(source.version ? { version: source.version } : {}),
      includeNodes: true,
    },
    // Never the write's tool call id: it keys the write's idempotency cache.
    { threadId: ctx.threadId, turnId: ctx.turnId, responseId: ctx.responseId },
  );
  if (outcome.isError) {
    return {
      isError: true,
      output: {
        ...outcome.result,
        command,
        message: fromMessage(source, outcome.result.message ?? outcome.result.status),
      },
    };
  }
  const version = outcome.result.read?.version ?? grant.destination.kind;
  return {
    nodes: outcome.nodes ?? [],
    copiedFrom: { uri: address.uri, version, revision: outcome.revision },
  };
}

/** A binary file has no blocks, so a copy of one takes no selection (D49). */
export function binaryCopySelectionMessage(
  source: CopySource,
  address: ResolvedDocumentAddress,
): string | undefined {
  if (address.fragment !== undefined) {
    return "A binary file is copied whole; drop the #fragment from from.path.";
  }
  if (source.in !== undefined) return "A binary file is copied whole; drop from.in.";
  return undefined;
}

/** Errors about the source say so, since `path` names the destination. */
export function fromMessage(source: CopySource, message: string): string {
  return `from ${source.path}: ${message}`;
}

/**
 * A binary copy duplicates the stored object at once (D24). It isn't a Yjs
 * write, so it has no write handle, isn't part of the reply's save and is
 * never drafted.
 */
export async function copyBinary(
  deps: ToolWiringDeps,
  context: ResolvedModelContextPort,
  input: Extract<WriteToolInput, { command: "copy" }>,
  source: BinaryFileRef,
  sourceGrant: FileGrant<"read">,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
) {
  // Binary files have no drafts or revisions, so the copy always reads the live file.
  const copied = await copyBinaryDocument({
    port: context.port,
    livePort: context.livePort(),
    objectStore: deps.objectStore,
    source,
    sourceGrant,
    destinationUri: splitDocumentFile(input.path).filePath,
    copiedFrom: { uri: source.uri, version: "live", revision: null },
  });
  if (!copied.ok) {
    return writeToolError(input.command, contextErrorMessage(copied.error));
  }
  if (copied.value.documentId) recordTouchInBackground(deps, copied.value.documentId, ctx);
  return {
    output: modelResult({
      command: "copy",
      status: "success",
      phase: "committed",
      payload: { path: input.path, destination: "live", copied: { from: input.from.path } },
    }),
  };
}
