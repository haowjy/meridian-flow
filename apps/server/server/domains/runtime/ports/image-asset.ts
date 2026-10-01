/** Late byte lookup for an already-admitted stable image identity. */
export type PersistedImageReference = { type: "image_reference"; documentId: string; uri: string };
export type ResolvedImageAsset = { mediaType: string; data: string | URL; sizeBytes: number };

/** A lookup failed without proving that an otherwise valid image is unavailable. */
export class ImageAssetResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageAssetResolutionError";
  }
}

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
