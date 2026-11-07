/** Test stand-in for the browser: start an upload, PUT its bytes to the incoming key, finish. */
import { randomUUID } from "node:crypto";
import type { ObjectStorePort } from "../../storage/index.js";
import { incomingObjectKey, type UploadIntake, type UploadIntakeOutcome } from "./upload-intake.js";

export async function uploadBytes(
  intake: UploadIntake,
  objectStore: ObjectStorePort,
  input: {
    intakeId?: string;
    actorUserId: string;
    projectId: string;
    chatId: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  },
): Promise<UploadIntakeOutcome> {
  const intakeId = input.intakeId ?? randomUUID();
  const started = await intake.start({
    intakeId,
    actorUserId: input.actorUserId,
    owner: { kind: "chat", projectId: input.projectId, chatId: input.chatId },
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  });
  if (!started.ok) return started;
  if (started.value.state === "finalized") return { ok: true, value: started.value.result };
  if (started.value.state === "reserved") {
    const put = await objectStore.put(
      incomingObjectKey(input.projectId, started.value.documentId),
      input.bytes,
      input.mimeType,
    );
    if (!put.ok) throw new Error(put.error.message);
  }
  return intake.finish({
    intakeId,
    actorUserId: input.actorUserId,
    owner: { kind: "chat", projectId: input.projectId, chatId: input.chatId },
  });
}
