/** Writer-facing words for a chat upload's type and age in the uploads menu. */
import { plural, t } from "@lingui/core/macro";
import type { ChatUpload } from "@/client/query/useChatUploads";

/** "PDF", "Image", "Text": what the file is, not its extension. */
export function uploadTypeLabel(fileType: ChatUpload["fileType"]): string {
  switch (fileType) {
    case "pdf":
      return t`PDF`;
    case "image":
    case "png":
    case "jpg":
    case "svg":
      return t`Image`;
    case "docx":
      return t`Word document`;
    case "markdown":
      return t`Markdown`;
    case "text":
      return t`Text`;
    case "csv":
      return t`Spreadsheet data`;
    case "python":
    case "typescript":
    case "javascript":
    case "json":
    case "shell":
    case "yaml":
      return t`Code`;
    case "notebook":
      return t`Notebook`;
    default:
      return t`File`;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "Just now", "2 min ago", "3 hours ago", "Yesterday", "4 days ago", else the date. */
export function attachedAgo(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE) return t`Just now`;
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return t`${minutes} min ago`;
  }
  const days = calendarDaysBetween(then, now);
  if (days === 0) {
    const hours = Math.floor(elapsed / HOUR);
    return plural(hours, { one: "# hour ago", other: "# hours ago" });
  }
  if (days === 1) return t`Yesterday`;
  if (days < 7) return plural(days, { one: "# day ago", other: "# days ago" });
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function calendarDaysBetween(then: number, now: number): number {
  const start = (value: number) => {
    const date = new Date(value);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  return Math.round((start(now) - start(then)) / (24 * HOUR));
}
