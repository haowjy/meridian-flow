/** UUIDv7 per-put identity: receipt and sweep fences use the embedded millisecond time. */
import { randomUUID } from "node:crypto";
export function stagingKey(importId: string, entryId: number): string {
  const random = randomUUID();
  const time = Date.now().toString(16).padStart(12, "0");
  return `imports/${importId}/${entryId}/${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`;
}
export function stagingKeyTime(key: string): number {
  const id = key.slice(key.lastIndexOf("/") + 1);
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
