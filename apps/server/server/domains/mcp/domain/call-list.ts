/** The one line, and the one cap, for a call that ran: a failed script's list and a restart's stub share them. */
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import { toContent } from "@meridian-flow/runtime/mcp";

const LIST_ARGUMENT_CHARS = 300;
const LIST_REPLY_CHARS = 400;
const LIST_CHARS = 12_000;

export const cut = (text: string, chars: number = LIST_REPLY_CHARS) =>
  text.length > chars ? `${text.slice(0, chars)}…` : text;

/** `id(arguments): status`, the arguments cut. */
export const callLine = (id: string, args: JsonValue, status: string) =>
  `${id}(${cut(JSON.stringify(args), LIST_ARGUMENT_CHARS)}): ${status}`;

export const answeredStatus = (replyText: string) => `answered ${cut(replyText)}`;

/** The lines that fit the list's size; the rest are counted in a last line. */
export function capLines(lines: readonly string[]): string[] {
  const shown: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > LIST_CHARS) {
      shown.push(
        `(${lines.length - shown.length} more calls not shown; each is kept in its record.)`,
      );
      break;
    }
    shown.push(line);
    size += line.length + 1;
  }
  return shown;
}

/** The text of a reply, as the model reads it. */
export const textOf = (reply: JsonObject) =>
  toContent(reply)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
