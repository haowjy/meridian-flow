/**
 * The race controller of the running-stack probes, installed on the named test hook points at
 * server start, never in production. `HOOK_CRASH_AT=<point>` with `HOOK_CRASH_ARM=<file>`
 * crashes: reaching the point while the file exists removes the file and exits with 137, so the
 * restarted server finds no arm and runs on. `HOOK_PAUSE_AT=<point>` with
 * `HOOK_PAUSE_FILE=<file>` pauses: reaching the point while the file exists holds that
 * operation, with whatever locks it has taken, until the probe deletes the file.
 */
import { existsSync, unlinkSync } from "node:fs";
import { isTestHookPoint, setTestHook, type TestHookPoint } from "./test-hooks.js";

const PAUSE_POLL_MS = 50;

/** Installs the controllers `env` asks for; the returned function removes them. */
export function installTestHookController(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  if (env.NODE_ENV === "production") return () => {};
  // One hook per point: a crash and a pause at the same point run in turn.
  const actions = new Map<TestHookPoint, (() => Promise<void>)[]>();
  const add = (name: string, key: string, action: () => Promise<void>) => {
    if (!isTestHookPoint(name)) throw new Error(`${key} names no test hook point: ${name}`);
    actions.set(name, [...(actions.get(name) ?? []), action]);
  };
  const { HOOK_CRASH_AT: crashAt, HOOK_CRASH_ARM: arm } = env;
  if (crashAt && arm) {
    add(crashAt, "HOOK_CRASH_AT", async () => {
      if (!existsSync(arm)) return;
      unlinkSync(arm);
      exit(137);
    });
  }
  const { HOOK_PAUSE_AT: pauseAt, HOOK_PAUSE_FILE: hold } = env;
  if (pauseAt && hold) {
    add(pauseAt, "HOOK_PAUSE_AT", async () => {
      while (existsSync(hold)) await new Promise((wake) => setTimeout(wake, PAUSE_POLL_MS));
    });
  }
  const removals = [...actions].map(([point, run]) =>
    setTestHook(point, async () => {
      for (const action of run) await action();
    }),
  );
  return () => {
    for (const remove of removals) remove();
  };
}
