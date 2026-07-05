/**
 * EditedBadge — the "Edited" state chip shown on library agents/skills that have
 * local overrides. Was copy-pasted verbatim in three library surfaces; centralized
 * here over the shared `Badge` primitive.
 */
import { Trans } from "@lingui/react/macro";

import { Badge, type BadgeProps } from "@/components/ui/badge";

export const EditedBadge = ({ className, ...props }: Omit<BadgeProps, "variant" | "children">) => {
  return (
    <Badge className={className} {...props}>
      <Trans>Edited</Trans>
    </Badge>
  );
};
