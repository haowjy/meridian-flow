import { randomUUID } from "node:crypto";
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
  workId: string;
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
}
const err = (code: PromotionErrorCode, message: string): PromotionResult => ({
  ok: false,
  error: { code, message },
});

export function createPromotionService(deps: PromotionServiceDeps): PromotionService {
  return {
    async promoteArtifact(input): Promise<PromotionResult> {
      const sourcePath = input.sourcePath.replace(/^\/+/, "");
      if (!sourcePath || sourcePath.includes(".."))
        return err("invalid_input", "Invalid source path");
      if (!input.projectId) return err("invalid_input", "projectId is required");
      if (!input.workId) return err("invalid_input", "workId is required");
      if (!input.provenance.agentSlug)
        return err("invalid_input", "provenance.agentSlug is required");
      const policy = evaluatePromotionPolicy(sourcePath);
      if (policy.decision === "skip" || !policy.mimeType)
        return err("policy_skip", `Path not eligible for promotion: ${sourcePath}`);
      const resultId = randomUUID();
      const objectKey = objectStoreKeyForResult(
        input.projectId,
        input.provenance.rootThreadId,
        resultId,
        sourcePath,
      );
      const put = await deps.objectStore.put(objectKey, input.bytes, policy.mimeType);
      if (!put.ok) return err("object_store_error", put.error.message);
      const resultsUri = resultsUriForSourcePath(
        input.workId,
        input.provenance.rootThreadId,
        sourcePath,
      );
      const provenance = {
        ...input.provenance,
        toolCallId: input.toolCallId ?? input.provenance.toolCallId,
      };
      try {
        const record = await deps.results.create({
          projectId: input.projectId,
          sourcePath,
          resultsUri,
          storageUrl: put.value.storageUrl,
          mimeType: policy.mimeType,
          sizeBytes: input.bytes.byteLength,
          provenance,
        });
        return {
          ok: true,
          value: {
            resultId: record.id,
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
        await deps.objectStore.delete(objectKey);
        return err(
          "repository_error",
          error instanceof Error ? error.message : "Failed to persist result row",
        );
      }
    },
  };
}
