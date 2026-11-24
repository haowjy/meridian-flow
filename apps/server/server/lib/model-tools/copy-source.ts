import type {
  DocumentVersion,
  WriteOutcome,
  WriteToolInput,
} from "@meridian/agent-edit/integration";
import {
  DOCUMENT_NOT_FOUND_MESSAGE,
  modelResult,
  splitDocumentFile,
} from "@meridian/agent-edit/integration";
import { copyBinaryDocument } from "../../domains/context/binary-copy.js";
import type {
  CopiedFrom,
  DocumentCreationMetadata,
} from "../../domains/context/document-metadata.js";
import type { BinaryFileRef, FileRef } from "../../domains/context/ports/context-port.js";
import type { FileGrant, Principal } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { documentGrant } from "./file-access.js";
import { type ReadSelection, readDocument } from "./read-document.js";
import { goneMessage, reachShown } from "./shown-paths.js";
import {
  contextErrorMessage,
  isToolError,
  type ResolvedDocumentAddress,
  type ResolvedModelContextPort,
  resolveToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";

type CopySource = { path: string; in?: ReadSelection["in"]; version?: DocumentVersion };

export interface CopiedSource {
  nodes: NonNullable<WriteOutcome["nodes"]>;
  sourceDocumentId: string;
  wholeDocument: boolean;
  aheadSettlements: ReadonlyMap<string, string>;
  copiedFrom: CopiedFrom;
  inherited?: Pick<DocumentCreationMetadata, "properties" | "aliases">;
}

export async function readCopySource(
  deps: ToolWiringDeps,
  principal: Principal,
  command: "insert" | "replace" | "copy",
  source: CopySource,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseIdentity">,
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
  ctx: Pick<ToolHandlerContext, "threadId" | "responseIdentity" | "shownNames">,
): Promise<{ ref: FileRef; address: ResolvedDocumentAddress } | WriteToolErrorOutput> {
  const call = await resolveToolCall(deps, ctx, source.version);
  if (isToolError(call)) return writeToolError(command, fromMessage(source, call.output.message));
  const { context } = call;
  const reached = await reachShown(deps, call, ctx, source.path, {
    ...(source.version ? { version: source.version } : {}),
  });
  if (reached.gone)
    return writeToolError(
      command,
      fromMessage(source, goneMessage(source.path, reached.gone)),
      "document_not_found",
    );
  const { filePath: basePath, fragment } = splitDocumentFile(reached.path);
  const ref = await context.port.stat(basePath);
  if (!ref.ok) {
    if (ref.error.code === "not_found") {
      return writeToolError(
        command,
        fromMessage(source, DOCUMENT_NOT_FOUND_MESSAGE),
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
      filePath: ref.value.uri,
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
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseIdentity">,
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
    // keep: never the write's tool call id here: it keys the write's idempotency cache
    { threadId: ctx.threadId, turnId: ctx.turnId, responseIdentity: ctx.responseIdentity },
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
    nodes: [...(outcome.nodes ?? [])],
    sourceDocumentId: address.documentId,
    wholeDocument: source.in === undefined && address.fragment === undefined,
    aheadSettlements: outcome.aheadSettlements ?? new Map(),
    copiedFrom: { uri: address.uri, version, revision: outcome.revision },
  };
}

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

export function fromMessage(source: CopySource, message: string): string {
  return `from ${source.path}: ${message}`;
}

export async function copyBinary(
  deps: ToolWiringDeps,
  context: ResolvedModelContextPort,
  input: Extract<WriteToolInput, { command: "copy" }>,
  source: BinaryFileRef,
  sourceGrant: FileGrant<"read">,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "agentSlug">,
) {
  const destinationUri = splitDocumentFile(input.path).filePath;
  const copied = await copyBinaryDocument({
    port: context.port,
    objectStore: deps.objectStore,
    release: deps.release,
    source,
    sourceGrant,
    origin: { type: "agent", agentSlug: ctx.agentSlug, threadId: ctx.threadId, turnId: ctx.turnId },
    destinationUri,
    copiedFrom: { uri: source.uri, version: "live", revision: null },
  });
  if (!copied.ok) {
    return writeToolError(input.command, contextErrorMessage(copied.error));
  }
  const destination = copied.value.placement;
  return {
    output: modelResult({
      command: "copy",
      status: "success",
      payload: {
        path: copied.value.uri,
        destination,
        ...(destination === "draft"
          ? { draftWork: context.resolution.primaryWorkAuthority?.workHandle ?? "/" }
          : {}),
        copied: { from: source.uri },
      },
    }),
  };
}
