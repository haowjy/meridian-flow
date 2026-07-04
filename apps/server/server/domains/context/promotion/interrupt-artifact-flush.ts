import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { InterruptArtifactFlushPort } from "../../runtime/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import type { PromotionService } from "./promotion-service.js";

export interface InterruptPromotionFlushDeps {
  promotion: PromotionService;
  objectStore: ObjectStorePort;
}

function objectArtifactKey(artifact: ArtifactRef): string | null {
  if (artifact.type !== "object") return null;
  return (
    objectStoreKeyFromStorageUrl(artifact.uri) ??
    (artifact.uri.includes("://") ? null : artifact.uri)
  );
}

function sourcePathForArtifact(artifact: ArtifactRef, key: string): string {
  if (artifact.type !== "object") return key;
  const label = artifact.label?.trim();
  if (label) return label.replace(/^\/+/, "");
  return key.replace(/^\/+/, "");
}

export function createInterruptArtifactFlush(
  deps: InterruptPromotionFlushDeps,
): InterruptArtifactFlushPort {
  return {
    async flushInterruptArtifacts(input) {
      for (const artifact of input.artifacts) {
        const key = objectArtifactKey(artifact);
        if (!key) continue;
        const stored = await deps.objectStore.get(key);
        if (!stored.ok) return { ok: false, error: stored.error };
        const promoted = await deps.promotion.promoteArtifact({
          projectId: input.projectId,
          workId: input.workId,
          sourcePath: sourcePathForArtifact(artifact, key),
          bytes: stored.value.bytes,
          provenance: input.provenance,
        });
        if (!promoted.ok && promoted.error.code !== "policy_skip") {
          return { ok: false, error: promoted.error };
        }
      }
      return { ok: true };
    },
  };
}
