import type { WorkHandle } from "../handles.js";
import type { WorkId } from "../ids.js";

export type WorkAuthorityDto = { workId: WorkId; workHandle: WorkHandle | null };

declare const resolvedWorkAuthorityBrand: unique symbol;

export type ResolvedWorkAuthority = WorkAuthorityDto & {
  readonly [resolvedWorkAuthorityBrand]: "ResolvedWorkAuthority";
};
