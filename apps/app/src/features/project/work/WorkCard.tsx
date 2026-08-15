/** WorkCard — compact Work identity and selection surface. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { Check, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";

export function WorkCard({
  work,
  current,
  isDefault,
  pending,
  error,
  onSelect,
  onEdit,
  registerEditFocus,
}: {
  work: Work;
  current: boolean;
  isDefault: boolean;
  pending: boolean;
  error: Error | null;
  onSelect: () => void;
  onEdit: () => void;
  registerEditFocus?: (node: HTMLElement | null) => void;
}) {
  return (
    <Card className="group relative min-w-0">
      <button
        type="button"
        aria-pressed={current}
        aria-label={work.name}
        className="focus-ring absolute inset-0 rounded-lg text-left disabled:cursor-not-allowed disabled:opacity-50"
        data-work-selection={work.id}
        disabled={pending}
        onClick={onSelect}
      >
        <span className="sr-only">{work.name}</span>
      </button>
      <CardHeader className="pointer-events-none relative">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          {current ? <Check className="size-4 shrink-0 text-primary" /> : null}
          <span className="truncate">{work.name}</span>
          {current ? (
            <span className="shrink-0 text-meta font-normal text-primary">
              <Trans>Current</Trans>
            </span>
          ) : null}
          {isDefault && !current ? (
            <span className="shrink-0 text-meta font-normal text-muted-foreground">
              <Trans>Default</Trans>
            </span>
          ) : null}
        </span>
        <span className="col-start-1 line-clamp-2 text-meta text-muted-foreground">
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
        <CardContent className="pointer-events-none relative space-y-2 text-meta text-muted-foreground">
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
