/**
 * NewBadge — the "New" state chip on a dock row for a document the AI proposed
 * creating but that has not been pushed to the writer's live project yet
 * (spec §5.5). It is a quiet neutral pill over the shared `Badge` primitive,
 * the single differentiator between a new-document row and an existing-document
 * row.
 */
import { Trans } from "@lingui/react/macro";

import { Badge, type BadgeProps } from "@/components/ui/badge";

export const NewBadge = ({ className, ...props }: Omit<BadgeProps, "variant" | "children">) => {
  return (
    <Badge className={className} {...props}>
      <Trans>New</Trans>
    </Badge>
  );
};
