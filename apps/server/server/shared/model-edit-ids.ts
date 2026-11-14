/** The ids a model's tool call derives for its effect: the same on a retry and in a recovering process. */
import { createHash } from "node:crypto";
import type { DocumentCommandId, ModelEditKey } from "@meridian/contracts";

// Arbitrary fixed namespaces: changing one orphans every stored command it named.
const COMMAND_NAMESPACE = "6f1c2f3e-5a0b-4c55-9d0e-3b7a1f6a2c11";
const BLOCK_NAMESPACE = "0b8e4a77-2d1c-4f19-8a63-c5d94e7b30a2";

export function modelEditIds(key: Pick<ModelEditKey, "responseId" | "toolCallId">): {
  commandId: DocumentCommandId;
  /** The id of the result block the call stores. */
  blockId: string;
  /** What a resend under this id must match; the key has no body to hash. */
  digest: string;
} {
  const name = `${key.responseId}:${key.toolCallId}`;
  return {
    commandId: uuidV5(COMMAND_NAMESPACE, name) as DocumentCommandId,
    blockId: uuidV5(BLOCK_NAMESPACE, name),
    digest: createHash("sha256").update(`model_edit\0${name}`).digest("hex"),
  };
}

/** RFC 4122 version 5: the node:crypto sha1 of the namespace bytes and the name. */
function uuidV5(namespace: string, name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
