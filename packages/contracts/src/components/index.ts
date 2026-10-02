/**
 * Purpose: Defines the shared custom component-block and interrupt-answer contracts used by server persistence and client renderers.
 * Key decisions: component block content stays JSON-natural and generic at the envelope, while invocation cards and `ask_user` props have explicit typed builders so server producers do not lose their required fields.
 */

import { z } from "zod";
import type { ThreadId, TurnId } from "../runtime/index.js";
import type { ExecutionReportDelivery, SavedOutcome } from "../spawn/index.js";
import type { JsonObject, JsonValue } from "../threads/index.js";

/** Registry key for a renderer/tool-owned custom component. */
export type ComponentKind = string;

export type InterruptAnswerProvenance = "user" | "auto";

/**
 * Metadata that correlates a rendered component with the suspended orchestrator interrupt.
 * `id` is the interrupt registry id, not the block id; `timeoutMs` is milliseconds until auto-resume.
 */
export type ComponentInterrupt = {
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
  interrupt?: ComponentInterrupt;
};

/** Runtime-created pointer in a child's first user turn; text is frozen at spawn. */
export type ThreadReferenceProps = {
  threadId: string;
  ref: string;
  title: string | null;
  agentName: string | null;
  lastActivityAt: string;
  text: string;
};

/** Writer-facing handoff card data, frozen when its seed is reserved. */
export type HandoffBriefProps = {
  state: "available" | "unavailable";
  brief: string | null;
  sourceThreadId: string;
  sourceRef: string;
  sourceTitle: string | null;
  cutoffTurnId: string;
  model: string | null;
  modelText: string;
};

/** Identity and timing shared by every retained child invocation card. */
type InvocationCardBase = {
  agentSlug: string;
  agentName: string;
  parentTurnId: TurnId;
  toolCallId: string;
  deliveryMode: Extract<ExecutionReportDelivery, "direct" | "background_notification">;
  startedAt: string;
  title?: string;
  fromThreadId?: ThreadId;
  fromThreadRef?: string;
  fromThreadTitle?: string | null;
};

/** Exact parent invocation identity retained on a child run's historical card. */
export type InvocationCardProps = InvocationCardBase &
  (
    | {
        childThreadId: ThreadId;
        execution: TurnId | null;
        terminalAt: null;
        outcome?: never;
        reason?: never;
      }
    | {
        childThreadId: ThreadId;
        execution: TurnId;
        terminalAt: string;
        outcome: SavedOutcome;
        reason?: never;
      }
    | {
        childThreadId?: never;
        execution?: never;
        terminalAt: string;
        outcome?: never;
        reason: string;
      }
  );

const invocationCardBaseSchema = z.strictObject({
  agentSlug: z.string(),
  agentName: z.string(),
  parentTurnId: z.string(),
  toolCallId: z.string(),
  deliveryMode: z.enum(["direct", "background_notification"]),
  startedAt: z.string(),
  title: z.string().optional(),
  fromThreadId: z.string().optional(),
  fromThreadRef: z.string().optional(),
  fromThreadTitle: z.string().nullable().optional(),
});

export const invocationCardPropsSchema = z.union([
  invocationCardBaseSchema.extend({
    childThreadId: z.string(),
    execution: z.string().nullable(),
    terminalAt: z.null(),
  }),
  invocationCardBaseSchema.extend({
    childThreadId: z.string(),
    execution: z.string(),
    terminalAt: z.string(),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
  }),
  invocationCardBaseSchema.extend({
    terminalAt: z.string(),
    reason: z.string().min(1),
  }),
]);

/** Parse the single persisted invocation-card shape; malformed cards are ignored. */
export function parseInvocationCard(content: unknown): InvocationCardProps | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const candidate = content as Record<string, unknown>;
  if (candidate.kind !== "helper-result") return null;
  const parsed = invocationCardPropsSchema.safeParse(candidate.props);
  return parsed.success ? (parsed.data as InvocationCardProps) : null;
}

export function buildInvocationCardContent(input: InvocationCardProps): ComponentBlockContent {
  return { kind: "helper-result", props: input as unknown as JsonObject };
}

/** Answer returned to interrupt tools after user response or auto-resume. */
export type InterruptAnswerEnvelope = {
  value: JsonValue;
  provenance: InterruptAnswerProvenance;
};

/** Props patched back onto a component block after a interrupt resolves. */
export type InterruptResolvedProps = {
  resolvedValue: string;
  answerProvenance: InterruptAnswerProvenance;
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
  answerProvenance?: InterruptAnswerProvenance;
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
  interruptId: string;
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

/**
 * The model's ask_user arguments: snake_case on the wire, the camelCase
 * AskUserToolInput after parsing. A choice question needs at least one option.
 */
export const askUserToolInputSchema = z
  .object({
    question: z.string().min(1).describe("The question for the user."),
    kind: z
      .enum(ASK_USER_KIND_VALUES)
      .describe("choice shows options to pick from; free-text shows a text field."),
    options: z
      .array(z.object({ value: z.string(), label: z.string() }).strict())
      .describe("Required for choice. value is returned; label is shown.")
      .optional(),
    recommended: z
      .string()
      .nullable()
      .describe("Value used if the question times out; null if none is safe.")
      .optional(),
    requires_human: z
      .boolean()
      .describe("Never resolve on timeout; wait for the user. Defaults to false.")
      .optional(),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .describe("Timeout in milliseconds; defaults to the project's.")
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.kind === "choice" && !input.options?.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "choice needs at least one { value, label } option",
      });
    }
  })
  .transform(
    (input): AskUserToolInput => ({
      question: input.question,
      kind: input.kind,
      ...(input.options !== undefined ? { options: input.options } : {}),
      recommended: input.recommended ?? null,
      requiresHuman: input.requires_human ?? false,
      ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
    }),
  );

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
    interrupt: {
      id: input.interruptId,
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
 * Normalize the interrupt response payload to the string value shown in component props and returned to the model.
 *
 * The websocket response frame wraps the component response payload under `value`, while the ask_user payload also uses a
 * `value` field. Peeling exactly one wrapper here avoids server/client copies that accidentally unwrap different depths.
 */
export function normalizeInterruptAnswerValue(responseValue: JsonValue): string {
  if (typeof responseValue === "string") return responseValue;

  if (responseValue && typeof responseValue === "object" && !Array.isArray(responseValue)) {
    const wrappedValue = responseValue.value;
    if (typeof wrappedValue === "string") return wrappedValue;
    if (wrappedValue !== undefined) return JSON.stringify(wrappedValue);
  }

  return JSON.stringify(responseValue);
}

export function interruptResolvedPropsFromAnswer(input: {
  value: JsonValue;
  provenance: InterruptAnswerProvenance;
}): InterruptResolvedProps {
  return {
    resolvedValue: normalizeInterruptAnswerValue(input.value),
    answerProvenance: input.provenance,
  };
}
