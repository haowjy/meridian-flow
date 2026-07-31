/** Runtime port for validating durable image references and resolving request-time image data. */

import type { PersistedImageReference } from "@meridian/contracts/threads";

export interface ImageAssetContext {
  projectId: string;
  threadId: string;
}

export interface ResolvedImageAsset {
  mediaType: string;
  data: string | URL;
  sizeBytes: number;
}

export interface ImageAssetPort {
  isValidReference(
    context: ImageAssetContext,
    reference: PersistedImageReference,
  ): Promise<boolean>;
  resolve(
    context: ImageAssetContext,
    reference: PersistedImageReference,
    options: { maxBytes: number },
  ): Promise<ResolvedImageAsset | null>;
}

export const unresolvedImageAssetPort: ImageAssetPort = {
  async isValidReference() {
    return false;
  },
  async resolve() {
    return null;
  },
};
