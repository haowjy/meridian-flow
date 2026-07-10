/** Pure ownership state for a temporary document's save name suggestion. */
import type { JSONContent } from "@tiptap/core";

export type TempDocumentNameState = { value: string; owned: boolean };

export function initialTempDocumentName(
  content: JSONContent,
  fallback: string,
): TempDocumentNameState {
  return { value: suggestedTempDocumentName(content) || fallback, owned: false };
}

export function updateSuggestedTempDocumentName(
  state: TempDocumentNameState,
  content: JSONContent,
): TempDocumentNameState {
  return state.owned ? state : { ...state, value: suggestedTempDocumentName(content) };
}

export function takeTempDocumentNameOwnership(
  _state: TempDocumentNameState,
  value: string,
): TempDocumentNameState {
  return { value, owned: true };
}

export function suggestedTempDocumentName(content: JSONContent): string {
  const firstBlock = content.type === "doc" ? content.content?.[0] : content;
  const firstLine = collectText(firstBlock).split("\n", 1)[0]?.trim() ?? "";
  return firstLine
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function collectText(content: JSONContent | undefined): string {
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  return (content.content ?? []).map(collectText).join("");
}
