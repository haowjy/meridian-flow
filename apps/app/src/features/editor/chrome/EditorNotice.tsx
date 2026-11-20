/**
 * The pill the editor says short-lived things in.
 *
 * One shape for every transient status a surface has to report: a verb that
 * reached the clipboard, an export the browser refused, a picture it would not
 * take. Two tones, because "done" and "failed" are the only two answers a
 * writer needs from something that will be gone in a moment. A few words, one
 * line: a longer message is cut, never wrapped. Drawn as `notifyFailure`'s pill is,
 * a failure marked by the same icon.
 *
 * Presentation only, and deliberately placeless: it blocks nothing, moves no
 * line of the manuscript, and knows nothing about where it hangs. WHERE a
 * notice appears belongs to the surface that raised it — over the object's own
 * corner, at the top of the scroll pane, inside a dialog — and how long it
 * stays belongs to whatever owns the notice.
 */

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
