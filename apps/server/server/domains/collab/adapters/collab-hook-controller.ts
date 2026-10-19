/**
 * The race controller of the running-stack probes, installed on collab's named hook points at
 * server start, never in production. `COLLAB_CRASH_AT=<point>` with `COLLAB_CRASH_ARM=<file>`
 * crashes: reaching the point while the file exists removes the file and exits with 137, so the
 * restarted server finds no arm and runs on. `COLLAB_PAUSE_AT=<point>` with
 * `COLLAB_PAUSE_FILE=<file>` pauses: reaching the point while the file exists holds that
 * operation, with whatever locks it has taken, until the probe deletes the file.
 */
import { existsSync, unlinkSync } from "node:fs";
import {
  type CollabHookPoint,
  isCollabHookPoint,
  setCollabHook,
} from "../domain/collab-test-hooks.js";

const PAUSE_POLL_MS = 50;

/** Installs the controllers `env` asks for; the returned function removes them. */
export function installCollabHookController(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  if (env.NODE_ENV === "production") return () => {};
  // One hook per point: a crash and a pause at the same point run in turn.
  const actions = new Map<CollabHookPoint, (() => Promise<void>)[]>();
  const add = (name: string, key: string, action: () => Promise<void>) => {
    if (!isCollabHookPoint(name)) throw new Error(`${key} names no collab hook point: ${name}`);
    actions.set(name, [...(actions.get(name) ?? []), action]);
  };
  const { COLLAB_CRASH_AT: crashAt, COLLAB_CRASH_ARM: arm } = env;
  if (crashAt && arm) {
    add(crashAt, "COLLAB_CRASH_AT", async () => {
      if (!existsSync(arm)) return;
      unlinkSync(arm);
      exit(137);
    });
  }
  const { COLLAB_PAUSE_AT: pauseAt, COLLAB_PAUSE_FILE: hold } = env;
  if (pauseAt && hold) {
    add(pauseAt, "COLLAB_PAUSE_AT", async () => {
      while (existsSync(hold)) await new Promise((wake) => setTimeout(wake, PAUSE_POLL_MS));
    });
  }
  const removals = [...actions].map(([point, run]) =>
    setCollabHook(point, async () => {
      for (const action of run) await action();
    }),
  );
  return () => {
    for (const remove of removals) remove();
  };
}
