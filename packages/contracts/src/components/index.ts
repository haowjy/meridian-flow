import type { JsonObject, JsonValue } from "../threads/index.js";

export type ComponentKind = string;

export type CheckpointAnswerProvenance = "user" | "auto";

export type ComponentCheckpoint = {
  id: string;
  timeoutMs?: number;
};

export type ComponentBlockContent = {
  kind: ComponentKind;
  props: JsonObject;
  checkpoint?: ComponentCheckpoint;
};

export type CheckpointAnswerEnvelope = {
  value: JsonValue;
  provenance: CheckpointAnswerProvenance;
};

export type CheckpointResolvedProps = {
  resolvedValue: string;
  answerProvenance: CheckpointAnswerProvenance;
};

export const ASK_USER_KIND_VALUES = ["choice", "free-text"] as const;
export type AskUserKind = (typeof ASK_USER_KIND_VALUES)[number];

export type AskUserOption = JsonObject & {
  value: string;
  label: string;
};

export type AskUserBaseProps = JsonObject & {
  question: string;
  recommended: string | null;
  requiresHuman: boolean;
  resolvedValue?: string;
  answerProvenance?: CheckpointAnswerProvenance;
};

export type AskUserChoiceProps = AskUserBaseProps & {
  kind: "choice";
  options: AskUserOption[];
};

export type AskUserFreeTextProps = AskUserBaseProps & {
  kind: "free-text";
};

export type AskUserProps = AskUserChoiceProps | AskUserFreeTextProps;

export type AskUserToolInput = {
  question: string;
  kind: AskUserKind;
  options?: AskUserOption[];
  recommended?: string | null;
  requiresHuman?: boolean;
};

export function isAskUserKind(value: string): value is AskUserKind {
  return (ASK_USER_KIND_VALUES as readonly string[]).includes(value);
}

export function parseAskUserOptions(value: unknown): AskUserOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isAskUserOption);
}

export function parseAskUserToolInput(value: unknown): AskUserToolInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.question !== "string" || typeof record.kind !== "string") return null;
  if (!isAskUserKind(record.kind)) return null;
  return {
    question: record.question,
    kind: record.kind,
    options: parseAskUserOptions(record.options),
    recommended: typeof record.recommended === "string" ? record.recommended : null,
    requiresHuman: record.requiresHuman === true,
  };
}

export function buildAskUserComponentContent(input: AskUserToolInput): ComponentBlockContent {
  const props: AskUserProps =
    input.kind === "choice"
      ? {
          kind: "choice",
          question: input.question,
          recommended: input.recommended ?? null,
          requiresHuman: input.requiresHuman ?? false,
          options: input.options ?? [],
        }
      : {
          kind: "free-text",
          question: input.question,
          recommended: input.recommended ?? null,
          requiresHuman: input.requiresHuman ?? false,
        };

  return {
    kind: "ask_user",
    props,
  };
}

function isAskUserOption(value: unknown): value is AskUserOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.value === "string" && typeof record.label === "string";
}
