/** GET /api/debug/package-fetch?url=[&commit=&ref=&path=] — authenticated, dev-only: fetches a GitHub tree through the package fetch port. */
import { createError, defineEventHandler, getQuery } from "nitro/h3";
import {
  createFetchBudget,
  FetchBudgetError,
  PackageFetchError,
} from "../../../domains/packages/index.js";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { debugPathsEnabled } from "../../../lib/env.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  if (!debugPathsEnabled) {
    throw createError({ statusCode: 404, message: "Debug paths are not enabled" });
  }
  const { url, commit, ref, path } = getQuery(event);
  if (typeof url !== "string") {
    throw createError({ statusCode: 400, message: "url is required" });
  }
  const budget = createFetchBudget();
  try {
    const tree = await app.packageFetcher.fetchTree(
      {
        url,
        pin:
          typeof commit === "string"
            ? {
                commit,
                ref: typeof ref === "string" ? ref : null,
                path: typeof path === "string" ? path : "",
              }
            : undefined,
      },
      budget,
    );
    return {
      commit: tree.commit,
      repo: tree.repo,
      ref: tree.ref,
      path: tree.path,
      dropped: tree.dropped,
      used: budget.used(),
      files: Object.entries(tree.files).map(([path, bytes]) => ({ path, bytes: bytes.byteLength })),
    };
  } catch (error) {
    if (error instanceof FetchBudgetError) {
      throw createError({ statusCode: 422, message: `budget ${error.budget}: ${error.message}` });
    }
    if (error instanceof PackageFetchError) {
      throw createError({ statusCode: 422, message: `${error.code}: ${error.message}` });
    }
    throw error;
  }
});
