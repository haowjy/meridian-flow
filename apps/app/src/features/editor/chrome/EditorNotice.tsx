import { CircleAlert } from "lucide-react";
import { dropdownPanelClass } from "@/components/ui/dropdown-presentation";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";

export type EditorNotice = { tone: "done" | "failed"; message: string };

export function EditorNoticePill({
  notice,
  className,
}: {
  notice: EditorNotice | null;
  className?: string;
}) {
  if (!notice) return null;

  return (
    <p
      role="status"
      data-editor-notice={notice.tone}
      className={cn(
        "pointer-events-none flex max-w-[min(24rem,100%)] animate-in items-center gap-2 px-3 py-1.5 fade-in-0",
        dropdownPanelClass,
        role.row,
        className,
      )}
    >
      {notice.tone === "failed" ? (
        <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
      ) : null}
      <span className="truncate">{notice.message}</span>
    </p>
  );
}
