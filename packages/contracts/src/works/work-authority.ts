import type { WorkHandle } from "../handles.js";
import { decodeWorkHandle } from "../handles.js";
import type { WorkId } from "../ids.js";

export type WorkAuthorityDto = { workId: WorkId; workHandle: WorkHandle | null };

declare const resolvedWorkAuthorityBrand: unique symbol;

export type ResolvedWorkAuthority = WorkAuthorityDto & {
  readonly [resolvedWorkAuthorityBrand]: "ResolvedWorkAuthority";
};

export function decodeWorkAuthorityDto(value: unknown): WorkAuthorityDto | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.workId !== "string") return null;
  if (candidate.workHandle === null) return { workId: candidate.workId, workHandle: null };
  const workHandle = decodeWorkHandle(candidate.workHandle);
  return workHandle ? { workId: candidate.workId, workHandle } : null;
}
