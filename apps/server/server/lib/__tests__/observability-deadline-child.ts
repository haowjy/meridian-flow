import { appendFileSync } from "node:fs";
import type { EventSink } from "../../domains/observability/index.js";
import {
  installProcessShutdownHooks,
  registerProcessShutdownCallback,
} from "../process-shutdown.js";

const tracePath = process.argv.at(-1);
if (!tracePath) throw new Error("Missing shutdown trace path");
const record = (event: string) => appendFileSync(tracePath, `${event}\n`);

registerProcessShutdownCallback(
  "runtime-drain",
  async () => {
    record("runtime-drain-start");
    await new Promise(() => undefined);
  },
  { timeoutMs: 50 },
);
registerProcessShutdownCallback("yjs-drain", () => {
  record("yjs-drain-start");
});

const eventSink: EventSink = { emit() {}, emitBatch() {}, async flush() {} };
installProcessShutdownHooks(eventSink);
process.stdout.write("ready\n");
setInterval(() => {}, 1_000);
