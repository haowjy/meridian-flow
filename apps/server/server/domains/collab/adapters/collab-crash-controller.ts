/**
 * The crash controller of the crash-and-resend probes, installed on collab's named hook
 * points at server start, never in production: `COLLAB_CRASH_AT=<point>` names a point and
 * `COLLAB_CRASH_ARM=<file>` arms it. Reaching the point while the file exists removes the
 * file, then exits the process with 137, so the restarted server finds no arm and runs on.
 */
import { existsSync, unlinkSync } from "node:fs";
import { isCollabHookPoint, setCollabHook } from "../domain/collab-test-hooks.js";

/** Installs the controller `env` asks for; the returned function removes it. */
export function installCollabCrashController(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  const { COLLAB_CRASH_AT: at, COLLAB_CRASH_ARM: arm, NODE_ENV } = env;
  if (NODE_ENV === "production" || !at || !arm) return () => {};
  if (!isCollabHookPoint(at)) throw new Error(`COLLAB_CRASH_AT names no collab hook point: ${at}`);
  return setCollabHook(at, async () => {
    if (!existsSync(arm)) return;
    unlinkSync(arm);
    exit(137);
  });
}
