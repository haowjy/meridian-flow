/** ContextFS-backed upload content adapter. */
import { classifyFiletype } from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import { resolvedWorkAuthority } from "../../projects/index.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type { UploadContentPort } from "./upload-intake.js";

export function createContextUploadContentPort(
  contextPorts: UnifiedContextPortFactory,
): UploadContentPort {
  return {
    async persist(input) {
      const decodedSlug =
        input.reservation.owner.kind === "work"
          ? decodeWorkSlug(input.reservation.owner.workSlug)
          : null;
      const authority =
        input.reservation.owner.kind === "work" && decodedSlug
          ? resolvedWorkAuthority({
              kind: "work",
              workId: input.reservation.owner.workId as never,
              workSlug: decodedSlug,
            })
          : null;
      if (input.reservation.owner.kind === "work" && !authority)
        return { ok: false, definite: true };
      const authorities = authority ? new Map([[authority.workSlug, authority]]) : new Map();
      const port = authority
        ? contextPorts.forWork(
            authority,
            input.reservation.projectId,
            input.actorUserId,
            authorities,
          )
        : contextPorts.forProject(input.reservation.projectId, input.actorUserId, authorities);
      const classification = classifyFiletype(input.reservation.fileType);
      const result =
        classification.kind === "tracked"
          ? await port.createTrackedDocument(
              input.reservation.canonicalUri,
              Buffer.from(input.bytes).toString("utf8"),
              {
                documentId: input.reservation.documentId,
                origin: {
                  type: "import",
                  userId: input.actorUserId,
                  source: "upload",
                  filename: input.reservation.finalPath,
                  sourceId: input.reservation.intakeId,
                },
              },
            )
          : await port.writeBinary(input.reservation.canonicalUri, {
              documentId: input.reservation.documentId,
              fileType: classification.kind === "unknown" ? "binary" : classification.fileType,
              storageUrl: input.storageUrl ?? "",
              mimeType: input.mimeType,
              sizeBytes: input.bytes.byteLength,
              origin: {
                type: "import",
                userId: input.actorUserId,
                source: "upload",
                filename: input.reservation.finalPath,
                sourceId: input.reservation.intakeId,
              },
            });
      return result.ok ? { ok: true } : { ok: false, definite: true };
    },
  };
}
