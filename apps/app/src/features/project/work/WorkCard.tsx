/** Shared compact card for Work collection rows. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { MoreHorizontal } from "lucide-react";
import type { MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";

export function WorkCard({
  work,
  href,
  pending,
  onOpen,
  onLifecycle,
  registerOpenFocus,
  registerLifecycleFocus,
}: {
  work: Work;
  href: string;
  pending: boolean;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
  onLifecycle: () => void;
  registerOpenFocus?: (node: HTMLAnchorElement | null) => void;
  registerLifecycleFocus?: (node: HTMLButtonElement | null) => void;
}) {
  return (
    <Card className="relative min-w-0 gap-3 py-5" aria-busy={pending || undefined}>
      <CardHeader className="gap-y-1 px-5">
        <a
          ref={registerOpenFocus}
          href={href}
          onClick={onOpen}
          className="focus-ring rounded-sm font-medium text-foreground after:absolute after:inset-0"
        >
          <span className="sr-only">{t`Open ${work.name}`}</span>
          <span aria-hidden className="line-clamp-1">
            {work.name}
          </span>
        </a>
        <p className="col-start-1 line-clamp-2 whitespace-pre-line text-meta text-muted-foreground">
          {work.goal || <Trans>No goal yet</Trans>}
        </p>
        <CardAction className="relative z-10">
          <Button
            ref={registerLifecycleFocus}
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label={t`Manage ${work.name}`}
            onClick={onLifecycle}
            className="[@media(pointer:coarse)]:size-11"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      {work.description ? (
        <CardContent className="line-clamp-2 px-5 text-meta text-muted-foreground">
          {work.description}
        </CardContent>
      ) : null}
    </Card>
  );
}
