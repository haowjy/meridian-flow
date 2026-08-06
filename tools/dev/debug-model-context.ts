/** LLM-friendly CLI for the same model-request evidence shown in the debug dashboard. */

import { pathToFileURL } from "node:url";
import type { ModelRequestDebugListResponse } from "@meridian/contracts/protocol";
import { apiThreadModelRequestsDebugPath } from "@meridian/contracts/protocol";
import {
  deriveModelRequestDebugViews,
  type ModelRequestDebugView,
} from "@meridian/contracts/threads";
import { getAuthenticatedDebugJson } from "./debug-http-client";

type ViewKind = "readable" | "raw" | "summary";

export type DebugModelContextOptions = {
  threadId: string;
  turnId?: string;
  iteration?: number;
  gatewayCallId?: string;
  view: ViewKind;
  all: boolean;
};

const RESPONSE_BYTES = 20 * 1024 * 1024;

function usage(): string {
  return [
    "Usage: pnpm --silent debug:model-context -- --thread <id> [filters]",
    "Filters: --turn <id> --iteration <n> --gateway-call <id> --all",
    "Views: --view readable|raw|summary (default: readable)",
  ].join("\n");
}

export function parseDebugModelContextArgs(args: string[]): DebugModelContextOptions {
  if (args[0] === "--") args = args.slice(1);
  const values: Record<string, string> = {};
  let all = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--all") {
      all = true;
      continue;
    }
    const key =
      flag === "--thread"
        ? "threadId"
        : flag === "--turn"
          ? "turnId"
          : flag === "--iteration"
            ? "iteration"
            : flag === "--gateway-call"
              ? "gatewayCallId"
              : flag === "--view"
                ? "view"
                : undefined;
    if (!key) throw new Error(`Unknown argument: ${flag}\n${usage()}`);
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a value\n${usage()}`);
    values[key] = value;
  }

  if (!values.threadId) throw new Error(`--thread is required\n${usage()}`);
  const view = values.view ?? "readable";
  if (view !== "readable" && view !== "raw" && view !== "summary") {
    throw new Error(`--view must be readable, raw, or summary\n${usage()}`);
  }
  const iteration = values.iteration === undefined ? undefined : Number(values.iteration);
  if (iteration !== undefined && (!Number.isInteger(iteration) || iteration < 0)) {
    throw new Error("--iteration must be a non-negative integer");
  }

  return {
    threadId: values.threadId,
    ...(values.turnId ? { turnId: values.turnId } : {}),
    ...(iteration === undefined ? {} : { iteration }),
    ...(values.gatewayCallId ? { gatewayCallId: values.gatewayCallId } : {}),
    view,
    all,
  };
}

export function selectModelRequestViews(
  views: readonly ModelRequestDebugView[],
  options: Pick<DebugModelContextOptions, "iteration" | "gatewayCallId" | "all">,
): ModelRequestDebugView[] {
  const matches = views.filter(
    ({ record }) =>
      (options.iteration === undefined || record.iteration === options.iteration) &&
      (options.gatewayCallId === undefined || record.gatewayCallId === options.gatewayCallId),
  );
  return options.all || options.iteration !== undefined || options.gatewayCallId !== undefined
    ? matches
    : matches.slice(-1);
}

function summary(view: ModelRequestDebugView) {
  return {
    gatewayCallId: view.record.gatewayCallId,
    threadId: view.record.threadId,
    turnId: view.record.turnId,
    iteration: view.record.iteration,
    requestedAt: view.record.requestedAt,
    agentSlug: view.record.agentSlug,
    requestDigest: view.record.requestDigest,
    requestBytes: view.record.requestBytes,
    capture: view.record.capture,
    prefix: view.prefix,
  };
}

export async function queryDebugModelContext(
  options: DebugModelContextOptions,
  repoRoot?: string,
): Promise<Record<string, unknown>> {
  const response = (await getAuthenticatedDebugJson({
    path: apiThreadModelRequestsDebugPath(options.threadId, { turnId: options.turnId }),
    maxResponseBytes: RESPONSE_BYTES,
    repoRoot,
  })) as ModelRequestDebugListResponse;
  const selected = selectModelRequestViews(deriveModelRequestDebugViews(response.records), options);

  return {
    query: options,
    retention: response.retention,
    matches: selected.length,
    requests: selected.map((view) => {
      if (options.view === "raw") return { prefix: view.prefix, record: view.record };
      if (options.view === "summary") return summary(view);
      return { ...summary(view), markdown: view.markdown };
    }),
  };
}

async function main(): Promise<void> {
  try {
    const result = await queryDebugModelContext(parseDebugModelContextArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
