import type { ReactNode } from "react";
import { useState } from "react";
import { Chip } from "@/components/ui/chip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A state chip that opens what it counts: an Agent file's problems or notes, a package's, what
 * a Save left out, or the files changed since the last save. Destructive when it means something
 * isn't in use, neutral for a note.
 */
export function FindingsChip({
  tone,
  word,
  heading,
  children,
  touch = false,
  label,
}: {
  tone: "destructive" | "warning" | "neutral";
  word: ReactNode;
  heading: string;
  /** The list; given the popover's close, for an item that leaves it. */
  children: (close: () => void) => ReactNode;
  touch?: boolean;
  /** For a word too short to say what it counts: the chip's name, and its tooltip. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const chip = (
    <Chip
      asChild
      tone={tone}
      className={cn("focus-ring cursor-pointer", touch ? "h-11" : "coarse:h-11")}
    >
      <button
        type="button"
        aria-label={label}
        data-findings-chip={tone}
        onClick={(event) => event.stopPropagation()}
      >
        {tone === "neutral" ? null : (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
        )}
        {word}
      </button>
    </Chip>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {label ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{chip}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{chip}</PopoverTrigger>
      )}
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-1rem)] p-2"
        // Portaled, but React carries its clicks up to the row the chip sits in, which would open.
        onClick={(event) => event.stopPropagation()}
      >
        <p className="px-2 pt-1 font-medium text-foreground text-sm">{heading}</p>
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

/** Sentences under a chip's heading, one per problem or note. */
export function SentenceList({
  items,
  className,
}: {
  items: readonly string[];
  className?: string;
}) {
  return (
    <ul
      className={cn(
        "flex list-disc flex-col gap-1 py-1 pr-2 pl-6 text-foreground text-xs marker:text-muted-foreground",
        className,
      )}
    >
      {items.map((item) => (
        <li key={item} className="whitespace-pre-line break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}
