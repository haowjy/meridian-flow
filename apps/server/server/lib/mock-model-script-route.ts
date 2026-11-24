import {
  type MockModelScriptEnqueued,
  type MockModelScriptState,
  parseMockModelScript,
} from "@meridian/contracts/protocol";
import type { MockScriptQueue } from "@meridian-flow/runtime/gateway/mock";
import { createError } from "nitro/h3";

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
): MockModelScriptEnqueued {
  const target = requireQueue(queue);
  const parsed = parseMockModelScript(body);
  if (!parsed.ok) throw createError({ statusCode: 400, message: parsed.error });
  return target.enqueue(parsed.value);
}

export function readMockModelScripts(queue: MockScriptQueue | null): MockModelScriptState {
  return requireQueue(queue).state();
}

export function clearMockModelScripts(
  queue: MockScriptQueue | null,
  id?: string,
): MockModelScriptState {
  return requireQueue(queue).clear(id);
}
