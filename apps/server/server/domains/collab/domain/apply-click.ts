/** Form-check a frozen Apply click while execution is unavailable (lane A replaces this). */
import type { ApplyClick, ApplyClickRefusalReason } from "@meridian/contracts/branches";
import * as Y from "yjs";

export function checkApplyClick(request: ApplyClick): ApplyClickRefusalReason | null {
  try {
    const bytes = Buffer.from(request.snapshot, "base64");
    if (bytes.toString("base64") !== request.snapshot) return "malformed";
    Y.decodeSnapshotV2(bytes);
    return null;
  } catch {
    return "malformed";
  }
}
