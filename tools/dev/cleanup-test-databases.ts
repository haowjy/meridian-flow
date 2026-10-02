#!/usr/bin/env tsx
import { mapConcurrentSettled, throwSettledFailures } from "./lib/bounded-concurrency";
/** Detached cleanup of exactly one parent's managed DB run; stale GC is the fallback. */
import { dropDatabaseForUrl, parseTargetDatabase } from "./lib/dev-db";
import { resolveCurrentRepoRoot, resolveMainDatabaseNames } from "./lib/dev-env";
import { managedTestDatabaseOwnerPid, managedTestDatabaseWorkerUrl } from "./lib/test-db-lifecycle";

process.once("message", async (message: { databaseUrl: string; workerCount: number }) => {
  try {
    const mainNames = resolveMainDatabaseNames(resolveCurrentRepoRoot());
    const { targetDb } = parseTargetDatabase(message.databaseUrl);
    if (managedTestDatabaseOwnerPid(targetDb, mainNames) !== process.ppid) {
      throw new Error("Refusing cleanup: managed database is not owned by the sending parent.");
    }
    const workerUrls = Array.from({ length: message.workerCount }, (_, index) =>
      managedTestDatabaseWorkerUrl(message.databaseUrl, index + 1),
    );
    // Acknowledge ownership while the parent is still alive. No credentials go in argv or logs.
    process.send?.("ready");
    process.disconnect();
    const workerResults = await mapConcurrentSettled(workerUrls, 4, async (url) => {
      const result = await dropDatabaseForUrl(url, mainNames);
      console.log(`Dropped ${result.targetDb}.`);
      return result;
    });
    const templateResult = await mapConcurrentSettled([message.databaseUrl], 1, async (url) => {
      const result = await dropDatabaseForUrl(url, mainNames);
      console.log(`Dropped ${result.targetDb}.`);
      return result;
    });
    throwSettledFailures(
      "DB test cleanup",
      [...workerResults, ...templateResult],
      [...workerUrls, message.databaseUrl].map((url) => parseTargetDatabase(url).targetDb),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
});
