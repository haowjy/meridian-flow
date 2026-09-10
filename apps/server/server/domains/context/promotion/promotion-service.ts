import { randomUUID } from "node:crypto";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ResolvedWorkAuthority } from "@meridian/contracts/works";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { ProjectWorkAuthorityResolver } from "../../projects/index.js";
import type { ObjectStorePort } from "../../storage/ports/object-store.js";
import { objectStoreKeyForResult, resultsUriForSourcePath } from "./artifact-paths.js";
import type { ResultRepository } from "./ports/result-repository.js";
import { evaluatePromotionPolicy } from "./promotion-policy.js";
import type { ResultProvenance } from "./result-provenance.js";

export type PromotionErrorCode =
  | "invalid_input"
  | "object_store_error"
  | "policy_skip"
  | "repository_error";
export interface PromotionError {
  code: PromotionErrorCode;
  message: string;
}
export type PromotionResult =
  | { ok: true; value: PromotedArtifact }
  | { ok: false; error: PromotionError };
export interface PromoteArtifactInput {
  projectId: string;
  workId: string | null;
  sourcePath: string;
  bytes: Uint8Array;
  provenance: ResultProvenance;
  toolCallId?: string | null;
}
export interface PromotedArtifact {
  resultId: string;
  sourcePath: string;
  resultsUri: string;
  storageUrl: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  provenance: ResultProvenance;
}
export interface PromotionService {
  promoteArtifact(input: PromoteArtifactInput): Promise<PromotionResult>;
}
export interface PromotionServiceDeps {
  objectStore: ObjectStorePort;
  results: ResultRepository;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  eventSink: EventSink;
}
const err = (code: PromotionErrorCode, message: string): PromotionResult => ({
  ok: false,
  error: { code, message },
});

export function createPromotionService(deps: PromotionServiceDeps): PromotionService {
  const diagnose = (name: string, payload: Record<string, unknown>) =>
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "context.promotion",
      name,
      payload,
    });

  async function cleanup(
    prepared: { projectId: string; resultId: string; objectKey: string; resultsUri: string },
    primaryError: string,
  ): Promise<void> {
    try {
      const deleted = await deps.objectStore.delete(prepared.objectKey);
      if (!deleted.ok) {
        diagnose("compensation.failed", {
          ...prepared,
          primaryError,
          cleanupError: deleted.error,
        });
      }
    } catch (cause) {
      diagnose("compensation.failed", {
        ...prepared,
        primaryError,
        cleanupError: unknownToEventPayload(cause),
      });
    }
  }

  return {
    async promoteArtifact(input): Promise<PromotionResult> {
      const sourcePath = input.sourcePath.replace(/^\/+/, "");
      if (!sourcePath || sourcePath.includes(".."))
        return err("invalid_input", "Invalid source path");
      if (!input.projectId) return err("invalid_input", "projectId is required");
      if (!input.provenance.agentSlug)
        return err("invalid_input", "provenance.agentSlug is required");
      const policy = evaluatePromotionPolicy(sourcePath);
      if (policy.decision === "skip" || !policy.mimeType)
        return err("policy_skip", `Path not eligible for promotion: ${sourcePath}`);
      let authority: ResolvedWorkAuthority | { kind: "none" } = { kind: "none" };
      if (input.workId) {
        try {
          const resolved = await deps.workAuthorityResolver.byId(input.projectId, input.workId);
          if (resolved) authority = resolved;
        } catch (cause) {
          return err(
            "repository_error",
            cause instanceof Error ? cause.message : "Failed to resolve Work authority",
          );
        }
      }
      if (input.workId && authority.kind === "none")
        return err("invalid_input", "Work is not available in this project");
      const resultId = randomUUID();
      const objectKey = objectStoreKeyForResult(
        input.projectId,
        input.provenance.rootThreadId,
        resultId,
        sourcePath,
      );
      const resultsUri = resultsUriForSourcePath(
        authority,
        input.provenance.rootThreadId,
        sourcePath,
      );
      const roundTrip = parseContextUri(resultsUri);
      if (!roundTrip.ok || roundTrip.value.normalized !== resultsUri) {
        return err("invalid_input", "Prepared result URI did not round-trip");
      }
      const provenance = {
        ...input.provenance,
        toolCallId: input.toolCallId ?? input.provenance.toolCallId,
      };
      const prepared = { projectId: input.projectId, resultId, objectKey, resultsUri };
      let put: Awaited<ReturnType<ObjectStorePort["put"]>>;
      try {
        put = await deps.objectStore.put(objectKey, input.bytes, policy.mimeType);
      } catch (cause) {
        await cleanup(prepared, cause instanceof Error ? cause.message : "Object put threw");
        return err(
          "object_store_error",
          cause instanceof Error ? cause.message : "Object put failed",
        );
      }
      if (!put.ok) return err("object_store_error", put.error.message);

      try {
        const outcome = await deps.results.createOrConverge({
          id: resultId,
          projectId: input.projectId,
          sourcePath,
          resultsUri,
          storageUrl: put.value.storageUrl,
          mimeType: policy.mimeType,
          sizeBytes: input.bytes.byteLength,
          provenance,
        });
        if (outcome.kind === "definitely_not_committed") {
          await cleanup(prepared, outcome.error);
          return err("repository_error", outcome.error);
        }
        if (outcome.kind === "unknown") {
          diagnose("reconciliation.unknown", { ...prepared, error: outcome.error });
          return err("repository_error", outcome.error);
        }
        return {
          ok: true,
          value: {
            resultId: outcome.record.id,
            sourcePath,
            resultsUri,
            storageUrl: put.value.storageUrl,
            objectKey,
            mimeType: policy.mimeType,
            sizeBytes: input.bytes.byteLength,
            provenance,
          },
        };
      } catch (error) {
        diagnose("reconciliation.unknown", {
          ...prepared,
          error: unknownToEventPayload(error),
        });
        return err(
          "repository_error",
          error instanceof Error ? error.message : "Failed to persist result row",
        );
      }
    },
  };
}
