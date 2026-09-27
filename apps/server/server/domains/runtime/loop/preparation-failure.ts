/** Writer-facing failures shared by preparation and its atomic failed-reply landing. */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import { ThreadConversationContextError } from "../../threads/index.js";
import { ImageAssetResolutionError } from "../ports/image-asset.js";
import { CompactionPreparationError } from "./compaction/decision.js";
export function writerFacingPreparationError(
  error: Error,
): ReturnType<typeof meridianErrorFromSystem> {
  if (error instanceof CompactionPreparationError)
    return meridianErrorFromSystem(error.reason, error.message);
  if (error instanceof ThreadConversationContextError) {
    return meridianErrorFromSystem(
      "thread_context_error",
      "This chat's fork history couldn't be loaded.",
    );
  }
  if (error instanceof ImageAssetResolutionError) {
    return meridianErrorFromSystem(
      "image_resolution_failed",
      "An image in this message couldn't be loaded. Try again.",
    );
  }
  return meridianErrorFromSystem(
    "request_preparation_failed",
    "This message couldn't be prepared. Try again.",
  );
}
