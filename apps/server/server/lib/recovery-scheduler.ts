/** Starts independent recovery passes; domains own their claims and cursors. */
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import { RECOVERY_LANE_STOP_DEADLINE_MS } from "./shutdown-deadlines.js";

export interface RecoveryLane {
  name: string;
  delayMs: number;
  run(signal: AbortSignal): Promise<number>;
}

export function startRecoveryScheduler(lanes: readonly RecoveryLane[], eventSink: EventSink) {
  let stopped = false;
  const abort = new AbortController();
  const states = new Map(
    lanes.map((lane) => [
      lane.name,
      {
        lane,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
        running: undefined as Promise<void> | undefined,
        wakePending: false,
      },
    ]),
  );

  function schedule(
    state: typeof states extends Map<string, infer S> ? S : never,
    delayMs: number,
  ) {
    if (stopped) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      start(state);
    }, delayMs);
    state.timer.unref();
  }

  function start(state: typeof states extends Map<string, infer S> ? S : never) {
    if (stopped || state.running) return;
    const { lane } = state;
    const pass = (async () => {
      const started = Date.now();
      try {
        const count = await lane.run(abort.signal);
        emitEvent(eventSink, {
          level: "info",
          source: `recovery.${lane.name}`,
          name: "pass.completed",
          payload: { durationMs: Date.now() - started, count },
        });
      } catch (cause) {
        emitEvent(eventSink, {
          level: "error",
          source: `recovery.${lane.name}`,
          name: "pass.failed",
          payload: { durationMs: Date.now() - started, ...unknownToEventPayload(cause) },
        });
      }
    })();
    state.running = pass;
    void pass.finally(() => {
      state.running = undefined;
      const delay = state.wakePending ? 0 : lane.delayMs;
      state.wakePending = false;
      schedule(state, delay);
    });
  }

  for (const state of states.values()) start(state);
  return {
    wake(name: string) {
      const state = states.get(name);
      if (!state || stopped) return;
      if (state.running) state.wakePending = true;
      else schedule(state, 0);
    },
    async stop() {
      stopped = true;
      abort.abort();
      for (const state of states.values()) {
        if (state.timer) clearTimeout(state.timer);
        state.timer = undefined;
      }
      let deadline!: ReturnType<typeof setTimeout>;
      await Promise.race([
        Promise.all(
          [...states.values()].flatMap((state) => (state.running ? [state.running] : [])),
        ),
        new Promise<void>((resolve) => {
          deadline = setTimeout(() => {
            for (const { lane, running } of states.values())
              if (running)
                emitEvent(eventSink, {
                  level: "warn",
                  source: `recovery.${lane.name}`,
                  name: "shutdown.abandoned",
                  payload: {},
                });
            resolve();
          }, RECOVERY_LANE_STOP_DEADLINE_MS);
        }),
      ]);
      clearTimeout(deadline);
    },
  };
}
