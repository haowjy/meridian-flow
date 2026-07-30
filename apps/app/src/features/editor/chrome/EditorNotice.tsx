/**
 * The pill the editor says short-lived things in.
 *
 * One shape for every transient status a surface has to report: a verb that
 * reached the clipboard, an export the browser refused, a picture it would not
 * take. Two tones, because "done" and "failed" are the only two answers a
 * writer needs from something that will be gone in a moment; a failure keeps
 * its reason, which is what law 5 asks of a refusal.
 *
 * Presentation only, and deliberately placeless: it blocks nothing, moves no
 * line of the manuscript, and knows nothing about where it hangs. WHERE a
 * notice appears belongs to the surface that raised it — over the object's own
 * corner, at the top of the scroll pane, inside a dialog — and how long it
 * stays belongs to whatever owns the notice.
 */

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
        "pointer-events-none animate-in whitespace-nowrap rounded-full border px-3 py-1 text-caption shadow-card fade-in-0",
        notice.tone === "failed"
          ? "border-destructive-border bg-destructive-tint text-destructive"
          : "border-border bg-card text-ink-muted",
        className,
      )}
    >
      {notice.message}
    </p>
  );
}
