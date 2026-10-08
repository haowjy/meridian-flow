/**
 * ContextFS's tree capability: the location CAS operations (move, delete,
 * restore, provisional graduation) a ContextFS adapter runs through its
 * ContextTreeMutationStore, filtered by the adapter's document visibility.
 */
import {
  classifyFiletype,
  type Filetype,
  filetypeForKnownPath,
  filetypeForPath,
  type YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type {
  AdapterDeleteResult,
  AdapterFault,
  AdapterMoveResult,
  AdapterRestoreResult,
  ContextTreeAdapter,
} from "../../ports/context-adapter.js";
import type {
  ContextLocationToken,
  ContextTreeDeleteCommand,
  ContextTreeMutationError,
  ContextTreeMutationStore,
  PreparedContextMove,
} from "../../ports/context-tree-mutation-store.js";

export function trackedSchemaForPersistedFiletype(
  filetype: string | null | undefined,
): Result<YjsTrackedSchemaType, AdapterFault> {
  const classification = classifyFiletype(filetype);
  if (classification.kind === "tracked") return Ok(classification.schemaType);
  if (classification.kind === "unknown") return Ok("document");
  return Err({
    code: "io_error",
    message: `Tracked document has registered ${classification.kind} filetype: ${filetype}`,
  });
}

function moveFiletypeTransition(
  source: Extract<ContextLocationToken, { kind: "file" }>,
  destinationPath: string,
): Result<Filetype | null, AdapterFault> {
  if (source.filetype === null) {
    const knownDestinationFiletype = filetypeForKnownPath(destinationPath);
    if (knownDestinationFiletype === null) return Ok(null);
    const destination = classifyFiletype(knownDestinationFiletype);
    if (destination.kind !== "tracked") return Ok(null);
    return Err({
      code: "invalid_operation",
      reason: "file_type_conversion",
      message: `Cannot rename storage-backed file ${source.path} to ${destinationPath} because tracked documents require a Yjs schema`,
    });
  }

  const sourceSchema = trackedSchemaForPersistedFiletype(source.filetype);
  if (!sourceSchema.ok) return sourceSchema;
  const destinationFiletype = filetypeForPath(destinationPath);
  const destination = classifyFiletype(destinationFiletype);
  if (destination.kind !== "tracked") {
    return Err({
      code: "invalid_operation",
      reason: "file_type_conversion",
      message: `Cannot rename tracked document ${source.path} to ${destinationPath} because binary and custom files use a different storage model`,
    });
  }
  if (destination.schemaType !== sourceSchema.value) {
    return Err({
      code: "invalid_operation",
      reason: "document_type_conversion",
      message: `Cannot rename ${source.path} to ${destinationPath} because changing the Yjs schema from ${sourceSchema.value} to ${destination.schemaType} requires an explicit conversion`,
    });
  }
  return Ok(destinationFiletype);
}

export function createContextFsTree(deps: {
  mutationStore: ContextTreeMutationStore;
  contextSourceId(): Promise<string>;
  /** Whether this adapter's view sees the document; a hidden one can't be moved or deleted. */
  isVisibleDocument(documentId: string): Promise<boolean>;
}): ContextTreeAdapter {
  function mutationFault(error: ContextTreeMutationError): AdapterFault {
    switch (error.code) {
      case "stale_source":
        return { code: "stale_source" };
      case "stale_target":
        return { code: "stale_target" };
      case "conflict":
        return { code: "conflict" };
      case "invalid_operation":
      case "not_found":
        return { code: "invalid_operation" };
    }
  }

  async function inspectMovable(
    path: string,
  ): Promise<Result<ContextLocationToken | null, AdapterFault>> {
    const sourceId = await deps.contextSourceId();
    const token = await deps.mutationStore.inspect(sourceId, path);
    if (token?.kind === "file" && !(await deps.isVisibleDocument(token.nodeId))) return Ok(null);
    return Ok(token);
  }

  async function commitPreparedMove(
    prepared: PreparedContextMove,
  ): Promise<Result<AdapterMoveResult, AdapterFault>> {
    if (prepared.source.kind === "file") {
      // The mover found the source through its own adapter's inspectMovable,
      // which filters by that source's view in this transaction.
      const source = prepared.source;
      const destinationFiletype = moveFiletypeTransition(source, prepared.destinationPath);
      if (!destinationFiletype.ok) return destinationFiletype;
      const committed = await deps.mutationStore.commitMove({
        source,
        mover: prepared.mover,
        destinationSourceId: prepared.destinationSourceId,
        destinationPath: prepared.destinationPath,
        expectedTarget: prepared.expectedTarget,
        overwrite: prepared.overwrite,
        graduateProvisionalName:
          "graduateProvisionalName" in prepared && prepared.graduateProvisionalName === true,
        destinationFiletype: destinationFiletype.value,
      });
      if (!committed.ok) return Err(mutationFault(committed.error));
      return Ok({
        movedNodeId: committed.value.movedNodeId,
        ...(committed.value.linkUpdate ? { linkUpdate: committed.value.linkUpdate } : {}),
        path: prepared.destinationPath,
      });
    }
    const source = prepared.source;
    const committed = await deps.mutationStore.commitMove({
      source,
      mover: prepared.mover,
      destinationSourceId: prepared.destinationSourceId,
      destinationPath: prepared.destinationPath,
      expectedTarget: prepared.expectedTarget,
      overwrite: prepared.overwrite,
    });
    if (!committed.ok) return Err(mutationFault(committed.error));
    return Ok({
      movedNodeId: committed.value.movedNodeId,
      ...(committed.value.linkUpdate ? { linkUpdate: committed.value.linkUpdate } : {}),
      path: prepared.destinationPath,
    });
  }

  async function commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, AdapterFault>> {
    if (!(await deps.isVisibleDocument(source.nodeId))) {
      return Err({ code: "invalid_operation" });
    }
    const committed = await deps.mutationStore.commitProvisionalGraduation(source);
    if (!committed.ok) return Err(mutationFault(committed.error));
    return Ok(undefined);
  }

  async function commitRecursiveDelete(
    command: ContextTreeDeleteCommand,
  ): Promise<Result<AdapterDeleteResult, AdapterFault>> {
    if (command.root.kind === "file" && !(await deps.isVisibleDocument(command.root.nodeId)))
      return Err({ code: "invalid_operation" });
    const committed = await deps.mutationStore.commitRecursiveDelete(command);
    if (!committed.ok) return Err(mutationFault(committed.error));
    return Ok({
      deletedDocumentIds: committed.value.deletedDocumentIds,
      availabilityGeneration: committed.value.availabilityGeneration,
    });
  }

  /**
   * Restores a soft-deleted file in this adapter's source. A deleted file is
   * in no view, so visibility isn't checked: the caller names the file it
   * deleted, through a live-view adapter.
   */
  async function commitRestore(
    documentId: string,
  ): Promise<Result<AdapterRestoreResult | null, AdapterFault>> {
    const restored = await deps.mutationStore.commitRestore({
      sourceId: await deps.contextSourceId(),
      documentId,
    });
    if (!restored.ok) {
      return restored.error.code === "not_found" ? Ok(null) : Err(mutationFault(restored.error));
    }
    return Ok({ availabilityGeneration: restored.value.availabilityGeneration });
  }

  return {
    inspectMovable,
    commitProvisionalGraduation,
    commitPreparedMove,
    commitRecursiveDelete,
    commitRestore,
  };
}
