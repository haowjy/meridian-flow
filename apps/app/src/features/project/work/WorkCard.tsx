/** WorkCard — compact Work identity and selection surface. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function WorkCard({
  work,
  pending,
  error,
  onEdit,
  registerEditFocus,
}: {
  work: Work;
  pending: boolean;
  error: Error | null;
  onEdit: () => void;
  registerEditFocus?: (node: HTMLElement | null) => void;
}) {
  return (
    <Card
      aria-busy={pending || undefined}
      className="group relative min-w-0 gap-4 py-5"
      data-work-card={work.id}
    >
      <CardHeader className="pointer-events-none relative gap-x-3 gap-y-1 px-5">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 font-medium text-foreground transition-opacity",
            pending && "opacity-50",
          )}
          data-work-pending-content={work.id}
        >
          <span className="truncate">{work.name}</span>
        </span>
        <span
          className={cn(
            "col-start-1 line-clamp-2 text-meta text-muted-foreground transition-opacity",
            pending && "opacity-50",
          )}
        >
          {work.goal || <Trans>No goal yet</Trans>}
        </span>
        <CardAction className="pointer-events-auto">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label={t`Edit ${work.name}`}
            className="focus-ring [@media(pointer:coarse)]:size-11"
            data-work-focus={`edit:${work.id}`}
            ref={registerEditFocus}
            onClick={onEdit}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      {work.description || work.unpushedChangeCount || error ? (
        <CardContent
          className={cn(
            "pointer-events-none relative space-y-2 px-5 text-meta text-muted-foreground transition-opacity",
            pending && "opacity-50",
          )}
        >
          {work.description ? <p className="line-clamp-2">{work.description}</p> : null}
          {work.unpushedChangeCount ? (
            <p>
              <Plural
                value={work.unpushedChangeCount}
                one="# pending change"
                other="# pending changes"
              />
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert" data-work-error={work.id}>
              {error.message}
            </p>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
