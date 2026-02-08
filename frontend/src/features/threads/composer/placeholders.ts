/**
 * Rotating placeholder text for the composer.
 *
 * Round-robin cycling: picks the next placeholder per pool using
 * localStorage-backed indices, so text is different each session
 * and cycles through all options before repeating.
 *
 * The "@ for reference" hint is conditionally appended when the user
 * has never used @ mentions or hasn't used them in >7 days.
 */

const COMPOSE_PLACEHOLDERS = [
  "Chat away",
  "Write away",
  "Go ahead",
  "What's next?",
  "What's on your mind?",
  "Brainstorm away",
  "Talk it out",
  "Thinking out loud?",
  "Where were we?",
  "Let's work on it",
];

const INTERJECT_PLACEHOLDERS = [
  "Interject",
  "Chime in",
  "Actually...",
  "Hold on...",
  "Quick thought",
];

const EDIT_PLACEHOLDERS: Array<
  string | ((n: number, total: number) => string)
> = [
  (n, total) => `Draft ${n} of ${total}`,
  "Rewrite history",
  "Branch into another timeline",
  (n) => `Take ${n}`,
  "Plot twist incoming",
  "The director's cut",
  "The alternate universe",
];

// Round-robin: advance index in localStorage so each session gets the next one
const COMPOSE_LS_KEY = "meridian:placeholderIdx:compose";
const INTERJECT_LS_KEY = "meridian:placeholderIdx:interject";
const EDIT_LS_KEY = "meridian:placeholderIdx:edit";

function nextIndex(key: string, poolSize: number): number {
  const last = parseInt(localStorage.getItem(key) ?? "-1", 10);
  const next = (last + 1) % poolSize;
  localStorage.setItem(key, String(next));
  return next;
}

const composeIdx = nextIndex(COMPOSE_LS_KEY, COMPOSE_PLACEHOLDERS.length);
const interjectIdx = nextIndex(INTERJECT_LS_KEY, INTERJECT_PLACEHOLDERS.length);
const editIdx = nextIndex(EDIT_LS_KEY, EDIT_PLACEHOLDERS.length);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function shouldShowAtHint(lastUsed: number | null): boolean {
  if (lastUsed === null) return true;
  return Date.now() - lastUsed > SEVEN_DAYS_MS;
}

export function getComposePlaceholder(lastAtUsed: number | null): string {
  const base = COMPOSE_PLACEHOLDERS[composeIdx]!;
  return shouldShowAtHint(lastAtUsed) ? `${base}, @ for reference` : base;
}

export function getInterjectPlaceholder(): string {
  return INTERJECT_PLACEHOLDERS[interjectIdx]!;
}

export function getEditPlaceholder(
  draftNumber: number,
  totalDrafts: number,
  lastAtUsed: number | null,
): string {
  const suffix = shouldShowAtHint(lastAtUsed) ? ", @ for reference" : "";
  const entry = EDIT_PLACEHOLDERS[editIdx]!;
  const base =
    typeof entry === "function" ? entry(draftNumber, totalDrafts) : entry;
  return `${base}${suffix}`;
}
