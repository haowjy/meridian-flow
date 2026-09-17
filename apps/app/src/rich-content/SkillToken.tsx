/** Hover `/slug` token. Name and description only; not a document door. */

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SkillToken({
  slug,
  name,
  description,
}: {
  slug: string;
  name: string;
  description: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the tooltip; a button would look like a click-through */}
        <span data-composer-skill="" tabIndex={0}>
          /{slug}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="pointer-events-none max-w-56">
        <span className="block">{name}</span>
        {description ? <span className="block text-background/70">{description}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function TranscriptSkillToken({
  "data-slug": slug,
  "data-name": name,
  "data-description": description,
}: {
  "data-slug"?: string;
  "data-name"?: string;
  "data-description"?: string;
}) {
  if (!slug) return null;
  return <SkillToken slug={slug} name={name ?? slug} description={description ?? ""} />;
}
