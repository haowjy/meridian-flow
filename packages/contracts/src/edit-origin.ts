import type { DraftId } from "./ids.js";

export type EditOrigin = { kind: "live"; draftId?: DraftId } | { kind: "fork"; draftId: DraftId };
