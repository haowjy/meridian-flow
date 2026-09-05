/** Late byte lookup for an already-admitted stable image identity. */
export type PersistedImageReference = { type: "image_reference"; documentId: string; uri: string };
export type ResolvedImageAsset = { mediaType: string; data: string | URL; sizeBytes: number };
export interface ImageAssetPort {
  diagnose?(input: {
    threadId: string;
    projectId: string;
    reason: "model_unsupported" | "unavailable_or_over_budget";
  }): void;
  resolve(
    context: { projectId: string; threadId: string; actorUserId: string },
    reference: PersistedImageReference,
    options: { maxBytes: number },
  ): Promise<ResolvedImageAsset | null>;
}
export const unavailableImageAssetPort: ImageAssetPort = {
  async resolve() {
    return null;
  },
};
