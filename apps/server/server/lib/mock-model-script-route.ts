/**
 * Route core for /api/debug/mock-model/script — dev-only scripted replies for the
 * in-process mock model. 404 whenever no scriptable mock is composed (real providers, production).
 */
import { type MockModelScriptState, parseMockModelScript } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import type { MockScriptQueue } from "../domains/runtime/gateway/index.js";

function requireQueue(queue: MockScriptQueue | null): MockScriptQueue {
  if (!queue) {
    throw createError({
      statusCode: 404,
      message: "No scriptable mock model (start the dev stack with MODEL_PROVIDER=mock)",
    });
  }
  return queue;
}

export function enqueueMockModelScript(
  queue: MockScriptQueue | null,
  body: unknown,
): MockModelScriptState {
  const target = requireQueue(queue);
  const parsed = parseMockModelScript(body);
  if (!parsed.ok) throw createError({ statusCode: 400, message: parsed.error });
  return target.enqueue(parsed.value);
}

export function readMockModelScripts(queue: MockScriptQueue | null): MockModelScriptState {
  return requireQueue(queue).state();
}

export function clearMockModelScripts(queue: MockScriptQueue | null): MockModelScriptState {
  return requireQueue(queue).clear();
}
