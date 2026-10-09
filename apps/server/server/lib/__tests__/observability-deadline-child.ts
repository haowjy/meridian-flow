import { appendFileSync } from "node:fs";
import {
  getOrBindProcessObservability,
  installObservabilityShutdownHooks,
  registerProcessShutdownCallback,
} from "../observability.js";

const tracePath = process.argv.at(-1);
if (!tracePath) throw new Error("Missing shutdown trace path");
const record = (event: string) => appendFileSync(tracePath, `${event}\n`);

getOrBindProcessObservability(() => ({
  sink: {
    emit() {},
    emitBatch() {},
    async flush() {
      record("flush");
    },
  },
}));
registerProcessShutdownCallback(async () => {
  record("runtime-drain-start");
  process.stdout.write("draining\n");
  await new Promise(() => undefined);
});
registerProcessShutdownCallback(() => {
  record("yjs-drain-start");
});

installObservabilityShutdownHooks({ deadlineMs: Number(process.env.SHUTDOWN_DEADLINE_MS) });
process.stdout.write("ready\n");
setInterval(() => {}, 1_000);
