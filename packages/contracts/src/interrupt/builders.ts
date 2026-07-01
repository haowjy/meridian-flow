/**
 * Purpose: Builds interrupt component blocks and ask_user AskRequest payloads from the generalized interrupt contract.
 * Key decisions: ask_user remains one interrupt mechanism — it constructs a AskRequest and reuses the shared component builder.
 */
import {
  type AskUserKind,
  type AskUserOption,
  type AskUserToolInput,
  buildAskUserComponentContent,
  type ComponentBlockContent,
  isAskUserKind,
  parseAskUserOptions,
  parseAskUserToolInput,
} from "../components/index.js";
import type { JsonObject, JsonValue } from "../threads/index.js";
import type { AskRequest, JsonSchema } from "./index.js";

export function askUserAnswerSchema(input: {
  kind: AskUserKind;
  options?: AskUserOption[];
}): JsonSchema {
  if (input.kind === "choice") {
    const enumValues = (input.options ?? []).map((option) => option.value);
    return {
      type: "object",
      properties: {
        value: {
          type: "string",
          ...(enumValues.length > 0 ? { enum: enumValues } : {}),
        },
      },
      required: ["value"],
      additionalProperties: false,
    };
  }

  return {
    type: "object",
    properties: {
      value: { type: "string" },
    },
    required: ["value"],
    additionalProperties: false,
  };
}

export function askRequestFromAskUser(input: AskUserToolInput, interruptId: string): AskRequest {
  return {
    interruptId,
    prompt: input.question,
    artifacts: [],
    answerSchema: askUserAnswerSchema({ kind: input.kind, options: input.options }),
    recommended: input.recommended,
    requiresHuman: input.requiresHuman,
  };
}

function jsonObjectProperty(obj: JsonValue | undefined, key: string): JsonValue | undefined {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && key in obj) {
    return (obj as JsonObject)[key];
  }
  return undefined;
}

function askUserInputFromAnswerSchema(
  request: AskRequest,
): (AskUserToolInput & { question: string }) | null {
  const schema = request.answerSchema;
  const valueSchema = jsonObjectProperty(schema.properties, "value");
  if (!valueSchema || typeof valueSchema !== "object" || Array.isArray(valueSchema)) {
    return null;
  }

  const valueRecord = valueSchema as JsonObject;
  const enumValues = valueRecord.enum;
  if (Array.isArray(enumValues) && enumValues.every((value) => typeof value === "string")) {
    const options = enumValues.map((value) => ({ value, label: value }));
    return {
      question: request.prompt,
      kind: "choice",
      options,
      recommended:
        request.recommended === null || typeof request.recommended === "string"
          ? request.recommended
          : null,
      requiresHuman: request.requiresHuman ?? false,
    };
  }

  if (valueRecord.type === "string") {
    return {
      question: request.prompt,
      kind: "free-text",
      recommended:
        request.recommended === null || typeof request.recommended === "string"
          ? request.recommended
          : null,
      requiresHuman: request.requiresHuman ?? false,
    };
  }

  return null;
}

export function componentContentForAsk(
  request: AskRequest,
  timeoutMs: number,
): ComponentBlockContent {
  const askUser = askUserInputFromAnswerSchema(request);
  if (askUser && isAskUserKind(askUser.kind)) {
    return buildAskUserComponentContent({
      interruptId: request.interruptId,
      question: askUser.question,
      kind: askUser.kind,
      options: askUser.options,
      recommended: askUser.recommended,
      requiresHuman: askUser.requiresHuman,
      timeoutMs,
    });
  }

  return {
    kind: "form",
    props: {
      prompt: request.prompt,
      artifacts: request.artifacts as JsonValue,
      answerSchema: request.answerSchema,
      recommended: request.recommended ?? null,
      requiresHuman: request.requiresHuman ?? false,
    },
    interrupt: {
      id: request.interruptId,
      timeoutMs,
    },
  };
}

export function parseAskReplyValue(answerSchema: JsonSchema, responseValue: JsonValue): JsonValue {
  if (typeof responseValue === "string") {
    return { value: responseValue };
  }
  if (responseValue && typeof responseValue === "object" && !Array.isArray(responseValue)) {
    const record = responseValue as Record<string, unknown>;
    if ("value" in record) {
      return responseValue;
    }
  }

  const properties = answerSchema.properties;
  if (properties && typeof properties === "object" && "value" in properties) {
    return { value: responseValue };
  }

  return responseValue;
}

export function minimalAskRequest(interruptId: string, prompt = "test"): AskRequest {
  return {
    interruptId,
    prompt,
    artifacts: [],
    answerSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  };
}

export { parseAskUserOptions, parseAskUserToolInput };
