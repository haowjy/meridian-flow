import { appendFileSync } from "node:fs";
import type { EventSink } from "../../domains/observability/index.js";
import { installProcessShutdownHooks } from "../process-shutdown.js";

const tracePath = process.argv.at(-1);
if (!tracePath) throw new Error("Missing shutdown trace path");
const record = (event: string) => appendFileSync(tracePath, `${event}\n`);

const steps = [
  {
    stage: "websocket-admission" as const,
    callback: async () => {
      record("runtime-drain-start");
      await new Promise(() => undefined);
    },
  },
  {
    stage: "websocket-drain" as const,
    callback: () => record("yjs-drain-start"),
  },
];

const eventSink: EventSink = { emit() {}, emitBatch() {}, async flush() {} };
installProcessShutdownHooks(eventSink, steps);
process.stdout.write("ready\n");
setInterval(() => {}, 1_000);
