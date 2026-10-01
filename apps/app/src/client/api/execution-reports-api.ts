/** HTTP reads for exact saved child execution reports. */
import { apiThreadExecutionReportPath } from "@meridian/contracts/protocol";
import type { ThreadReportResult } from "@meridian/contracts/spawn";
import { getJson } from "./http-client";

export function getThreadExecutionReport(input: {
  threadId: string;
  childThreadId: string;
  execution: string;
}): Promise<ThreadReportResult> {
  return getJson(
    apiThreadExecutionReportPath(input.threadId, input.childThreadId, input.execution),
  );
}
