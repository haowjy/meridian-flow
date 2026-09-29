import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { installNitroDevShutdown } from "../nitro-dev-shutdown.js";

const tracePath = process.argv.at(-1);
if (!tracePath) throw new Error("Missing shutdown trace path");
const record = (event: string) => appendFileSync(tracePath, `${event}\n`);
const workerSource = `
  const { appendFileSync } = require('node:fs');
  const trace = process.argv[1];
  const record = (event) => appendFileSync(trace, event + '\\n');
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    record('worker-signal');
    setTimeout(() => {
      record('worker-drained');
      clearInterval(timer);
      process.exit(0);
    }, 200);
  });
  process.stdout.write('worker-ready\\n');
`;
const worker = spawn(process.execPath, ["-e", workerSource, tracePath], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise<void>((resolve, reject) => {
  worker.once("error", reject);
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk: string) => {
    if (chunk.includes("worker-ready")) resolve();
  });
});

installNitroDevShutdown({
  async close() {
    record("supervisor-close");
    worker.kill("SIGTERM");
  },
});
worker.once("exit", () => record("worker-exit"));
process.stdout.write("ready\n");
