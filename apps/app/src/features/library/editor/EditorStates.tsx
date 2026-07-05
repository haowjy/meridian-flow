/**
 * EditorStates — shared pending and failure states for definition editors.
 */
import { Trans } from "@lingui/react/macro";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const DEFAULT_LOADING_SKELETONS = [
  "h-16 w-full max-w-md",
  "h-10 w-full",
  "h-10 w-full",
  "h-48 w-full",
] as const;

export type EditorLoadingStateProps = {
  skeletonClassNames?: readonly string[];
};

export function EditorLoadingState({
  skeletonClassNames = DEFAULT_LOADING_SKELETONS,
}: EditorLoadingStateProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
      {skeletonClassNames.map((className, index) => (
        <Skeleton key={`${className}-${index}`} className={className} />
      ))}
    </div>
  );
}

export function EditorErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <Trans>Could not load this definition.</Trans>
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}
