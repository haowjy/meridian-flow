/** Starts independent recovery passes; domains own their claims and cursors. */
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";

export interface RecoveryLane {
  name: string;
  delayMs: number;
  run(): Promise<number>;
}

export function startRecoveryScheduler(lanes: readonly RecoveryLane[], eventSink: EventSink) {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const running = new Map<Promise<void>, string>();

  function start(lane: RecoveryLane) {
    const pass = (async () => {
      const started = Date.now();
      try {
        const count = await lane.run();
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
      if (!stopped) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          start(lane);
        }, lane.delayMs);
        timer.unref();
        timers.add(timer);
      }
    })();
    running.set(pass, lane.name);
    void pass.finally(() => running.delete(pass));
  }

  for (const lane of lanes) start(lane);
  return {
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      let deadline!: ReturnType<typeof setTimeout>;
      await Promise.race([
        Promise.all(running.keys()),
        new Promise<void>((resolve) => {
          deadline = setTimeout(() => {
            for (const name of running.values())
              emitEvent(eventSink, {
                level: "warn",
                source: `recovery.${name}`,
                name: "shutdown.abandoned",
                payload: {},
              });
            resolve();
          }, 5_000);
        }),
      ]);
      clearTimeout(deadline);
    },
  };
}
