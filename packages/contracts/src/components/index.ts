/**
 * Purpose: Defines the shared custom component-block and checkpoint-answer contracts used by server persistence and client renderers.
 * Key decisions: component block content stays JSON-natural and generic at the envelope, while the MVP `ask_user` component props are typed here so server builders, reducers, and renderers do not re-spell per-kind schemas.
 */
import type { JsonObject, JsonValue } from "../threads/index.js";

/** Registry key for a renderer/tool-owned custom component. */
export type ComponentKind = string;

export type CheckpointAnswerProvenance = "user" | "auto";

/**
 * Metadata that correlates a rendered component with the suspended orchestrator checkpoint.
 * `id` is the checkpoint registry id, not the block id; `timeoutMs` is milliseconds until auto-resume.
 */
export type ComponentCheckpoint = {
  id: string;
  timeoutMs?: number;
};

/**
 * Canonical content persisted in `Block.content` for `blockType: "custom"` component blocks.
 * Generic props keep the component registry as the extension seam: new components add a kind and renderer without changing the block envelope.
 */
export type ComponentBlockContent = {
  kind: ComponentKind;
  props: JsonObject;
  checkpoint?: ComponentCheckpoint;
};

/** Answer returned to checkpoint tools after user response or auto-resume. */
export type CheckpointAnswerEnvelope = {
  value: JsonValue;
  provenance: CheckpointAnswerProvenance;
};

/** Props patched back onto a component block after a checkpoint resolves. */
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
  options: AskUserOption[];
};

export type AskUserFreeTextProps = AskUserBaseProps;

export type AskUserComponentProps = AskUserChoiceProps | AskUserFreeTextProps;

export type AskUserComponentContent =
  | (ComponentBlockContent & {
      kind: "choice";
      props: AskUserChoiceProps;
    })
  | (ComponentBlockContent & {
      kind: "free-text";
      props: AskUserFreeTextProps;
    });

export type BuildAskUserComponentContentInput = {
  checkpointId: string;
  question: string;
  kind: AskUserKind;
  options?: AskUserOption[];
  recommended: string | null;
  requiresHuman: boolean;
  timeoutMs: number;
};

export type AskUserToolInput = {
  question: string;
  kind: AskUserKind;
  options?: AskUserOption[];
  recommended: string | null;
  requiresHuman: boolean;
  timeoutMs?: number;
};

export type AskUserToolInputParseResult =
  | { ok: true; value: AskUserToolInput }
  | { ok: false; message: string };

export const ASK_USER_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question to present to the user.",
    },
    kind: {
      type: "string",
      enum: ASK_USER_KIND_VALUES,
      description:
        "choice: present discrete options the user selects from. free-text: present a text input field.",
    },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          value: { type: "string" },
          label: { type: "string" },
        },
        required: ["value", "label"],
        additionalProperties: false,
      },
      description:
        "Options for 'choice' kind. Each has a value returned on selection and a label displayed to the user. Required when kind is 'choice'.",
    },
    recommended: {
      type: ["string", "null"],
      description:
        "Recommended value used as the safe default if auto-resume fires. Null means there is no safe default.",
    },
    requiresHuman: {
      type: "boolean",
      default: false,
      description:
        "Set true when the decision requires human judgment and must not be auto-resolved on timeout.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      description:
        "Optional checkpoint timeout in milliseconds. When omitted, the workbench/default checkpoint timeout is used.",
    },
  },
  required: ["question", "kind"],
  additionalProperties: false,
} as const;

export function isAskUserKind(value: unknown): value is AskUserKind {
  return ASK_USER_KIND_VALUES.includes(value as AskUserKind);
}

export function parseAskUserOptions(value: unknown): AskUserOption[] | null {
  if (!Array.isArray(value)) return null;

  const options: AskUserOption[] = [];
  for (const option of value) {
    if (!option || typeof option !== "object" || Array.isArray(option)) return null;
    const record = option as Record<string, unknown>;
    if (typeof record.value !== "string" || typeof record.label !== "string") return null;
    options.push({ value: record.value, label: record.label });
  }
  return options;
}

export function parseAskUserToolInput(input: unknown): AskUserToolInputParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "input must be an object" };
  }

  const args = input as Record<string, unknown>;
  if (typeof args.question !== "string" || args.question.length === 0) {
    return { ok: false, message: "question is required" };
  }
  if (!isAskUserKind(args.kind)) {
    return { ok: false, message: "kind must be choice or free-text" };
  }

  const parsedOptions = args.options === undefined ? undefined : parseAskUserOptions(args.options);
  if (args.kind === "choice" && (!parsedOptions || parsedOptions.length === 0)) {
    return { ok: false, message: "options required for choice kind" };
  }
  if (args.options !== undefined && !parsedOptions) {
    return { ok: false, message: "options must be an array of { value, label } strings" };
  }

  const timeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? Math.floor(args.timeoutMs)
      : undefined;

  return {
    ok: true,
    value: {
      question: args.question,
      kind: args.kind,
      options: parsedOptions ?? undefined,
      recommended: typeof args.recommended === "string" ? args.recommended : null,
      requiresHuman: args.requiresHuman === true,
      timeoutMs,
    },
  };
}

export function buildAskUserComponentContent(
  input: BuildAskUserComponentContentInput,
): AskUserComponentContent {
  const baseProps: AskUserBaseProps = {
    question: input.question,
    recommended: input.recommended,
    requiresHuman: input.requiresHuman,
  };

  const props =
    input.kind === "choice" ? { ...baseProps, options: input.options ?? [] } : baseProps;

  return {
    kind: input.kind,
    props,
    checkpoint: {
      id: input.checkpointId,
      timeoutMs: input.timeoutMs,
    },
  } as AskUserComponentContent;
}

export function askUserChoiceProps(content: ComponentBlockContent): AskUserChoiceProps | null {
  if (content.kind !== "choice") return null;
  const props = content.props;
  if (typeof props.question !== "string") return null;
  if (typeof props.requiresHuman !== "boolean") return null;
  if (props.recommended !== null && typeof props.recommended !== "string") return null;
  const options = parseAskUserOptions(props.options);
  if (!options) return null;

  const typed: AskUserChoiceProps = {
    ...props,
    question: props.question,
    options,
    recommended: props.recommended,
    requiresHuman: props.requiresHuman,
  };
  if (typeof props.resolvedValue === "string") typed.resolvedValue = props.resolvedValue;
  if (props.answerProvenance === "user" || props.answerProvenance === "auto") {
    typed.answerProvenance = props.answerProvenance;
  }
  return typed;
}

export function askUserFreeTextProps(content: ComponentBlockContent): AskUserFreeTextProps | null {
  if (content.kind !== "free-text") return null;
  const props = content.props;
  if (typeof props.question !== "string") return null;
  if (typeof props.requiresHuman !== "boolean") return null;
  if (props.recommended !== null && typeof props.recommended !== "string") return null;

  const typed: AskUserFreeTextProps = {
    ...props,
    question: props.question,
    recommended: props.recommended,
    requiresHuman: props.requiresHuman,
  };
  if (typeof props.resolvedValue === "string") typed.resolvedValue = props.resolvedValue;
  if (props.answerProvenance === "user" || props.answerProvenance === "auto") {
    typed.answerProvenance = props.answerProvenance;
  }
  return typed;
}

/**
 * Normalize the checkpoint response payload to the string value shown in component props and returned to the model.
 *
 * The websocket response frame wraps the component response payload under `value`, while the ask_user payload also uses a
 * `value` field. Peeling exactly one wrapper here avoids server/client copies that accidentally unwrap different depths.
 */
export function normalizeCheckpointAnswerValue(responseValue: JsonValue): string {
  if (typeof responseValue === "string") return responseValue;

  if (responseValue && typeof responseValue === "object" && !Array.isArray(responseValue)) {
    const wrappedValue = responseValue.value;
    if (typeof wrappedValue === "string") return wrappedValue;
    if (wrappedValue !== undefined) return JSON.stringify(wrappedValue);
  }

  return JSON.stringify(responseValue);
}

export function checkpointResolvedPropsFromAnswer(input: {
  value: JsonValue;
  provenance: CheckpointAnswerProvenance;
}): CheckpointResolvedProps {
  return {
    resolvedValue: normalizeCheckpointAnswerValue(input.value),
    answerProvenance: input.provenance,
  };
}
