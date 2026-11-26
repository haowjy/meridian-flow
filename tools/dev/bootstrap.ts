import { resolve } from "node:path";
import { prepareDevDatabases } from "./lib/dev-infra.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

prepareDevDatabases(repoRoot)
  .then((prepared) => {
    for (const { database, created } of prepared) {
      console.log(`bootstrap: database "${database}" ${created ? "created" : "ready"}`);
    }
    console.log("Done. `pnpm dev` does this too; the dev user is provisioned on first sign-in");
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `bootstrap: ${error.message}` : error);
    process.exit(1);
  });
