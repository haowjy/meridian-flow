import { ChevronRight, ChevronsUpDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { role } from "./roles";

export function DisclosureMark({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      className={cn(
        "size-3 shrink-0 transition-transform motion-reduce:transition-none",
        role.secondary,
        open && "rotate-90",
        className,
      )}
    />
  );
}

export function ChooserMark({ className }: { className?: string }) {
  return (
    <ChevronsUpDown aria-hidden className={cn("size-3 shrink-0", role.secondary, className)} />
  );
}

export function withRowNote(children: ReactNode, note: ReactNode, end?: ReactNode): ReactNode {
  const hasNote = !(note === null || note === undefined || note === false || note === "");
  // Without a note or mark the children pass through as they are: an `asChild` row slots onto one child.
  if (!hasNote && !end) return children;
  return (
    <>
      {children}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-4">
        {hasNote ? <LabelNote>{note}</LabelNote> : null}
        {end}
      </span>
    </>
  );
}

export function LabelNote({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span className={cn(role.secondary, className)} {...props}>
      <span className="text-xs">{children}</span>
    </span>
  );
}
