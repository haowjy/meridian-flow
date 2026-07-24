/** Point each Vitest worker at its own clone of the migrated DB template. */
const encodedUrls = process.env.DB_TEST_DATABASE_URLS;
if (encodedUrls) {
  const databaseUrls = JSON.parse(encodedUrls) as string[];
  const poolId = Number.parseInt(process.env.VITEST_POOL_ID ?? "", 10);
  const databaseUrl = databaseUrls[poolId - 1];
  if (!databaseUrl) {
    throw new Error(`DB test worker ${process.env.VITEST_POOL_ID ?? "<unset>"} has no database.`);
  }
  process.env.DATABASE_URL = databaseUrl;
}
