/** Failure feedback held on the chat strip file. */
import { ReviewMessageText } from "@/features/draft-review/ReviewMessageText";
import type { DockFileFailure } from "./useDraftDock";

/** Why a command on a file did not land, in the strip's words. */
export function DockFailureText({ failure }: { failure: DockFileFailure; fileName: string }) {
  return <ReviewMessageText failure={failure.failure} />;
}
