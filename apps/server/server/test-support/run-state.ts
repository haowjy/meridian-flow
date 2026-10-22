/** An idle chat's run-state record, for fixtures that need a `RunState` and don't read it. */
import type { RunState } from "@meridian/contracts/threads";

export const EMPTY_RUN_STATE: RunState = {
  version: "0",
  items: [],
  sentThrough: 0,
  execution: null,
  mode: "direct",
  blocked: null,
};
