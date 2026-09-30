import { appendFileSync } from "node:fs";
import {
  installObservabilityShutdownHooks,
  registerProcessShutdownCallback,
} from "../observability.js";

const tracePath = process.argv.at(-1);
if (!tracePath) throw new Error("Missing shutdown trace path");
const record = (event: string) => appendFileSync(tracePath, `${event}\n`);

registerProcessShutdownCallback(async () => {
  record("runtime-drain-start");
  await new Promise(() => undefined);
});
registerProcessShutdownCallback(() => {
  record("yjs-drain-start");
});

installObservabilityShutdownHooks({ deadlineMs: 100 });
process.stdout.write("ready\n");
setInterval(() => {}, 1_000);
