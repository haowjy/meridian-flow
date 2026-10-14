/** `./mf mock`: script what the dev mock model answers next (MODEL_PROVIDER=mock stacks only). */
import {
  API_DEBUG_MOCK_MODEL_SCRIPT_PATH,
  type MockModelScript,
  type MockModelScriptEnqueued,
  type MockModelScriptState,
  parseMockModelScript,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";
import type { Session } from "../../core/session";

const MOCK_HINT =
  "Scripting needs the in-process mock model: start the stack with MODEL_PROVIDER=mock (or no provider keys).";

/** Queues a script; `defaultMatch` scopes it to the send that follows. */
export async function enqueueMockScript(
  session: Session,
  raw: unknown,
  defaultMatch?: string,
): Promise<MockModelScriptEnqueued> {
  const parsed = parseMockModelScript(raw);
  if (!parsed.ok) throw usageError(`Invalid mock script: ${parsed.error}`);
  const script: MockModelScript = {
    ...parsed.value,
    ...(parsed.value.match === undefined && defaultMatch ? { match: defaultMatch } : {}),
  };
  try {
    return await session.request<MockModelScriptEnqueued>(
      "POST",
      API_DEBUG_MOCK_MODEL_SCRIPT_PATH,
      script,
    );
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") {
      throw new CliError("unavailable", "The server has no scriptable mock model", {
        hint: MOCK_HINT,
      });
    }
    throw error;
  }
}

export function renderState(state: MockModelScriptState): string {
  if (state.scripts.length === 0) return "(no queued mock scripts)";
  return state.scripts
    .map(
      (script) =>
        `${script.id}  remaining=${script.remaining}${script.sticky ? " (sticky error)" : ""}  match=${script.match ?? "(any)"}`,
    )
    .join("\n");
}

/** Removes one queued script (e.g. the one a finished send queued). */
export async function removeMockScript(session: Session, id: string): Promise<void> {
  await session.request(
    "DELETE",
    `${API_DEBUG_MOCK_MODEL_SCRIPT_PATH}?id=${encodeURIComponent(id)}`,
  );
}
