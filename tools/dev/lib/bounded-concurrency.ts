/** Run async work with a fixed upper bound while attempting every item. */
export async function mapConcurrentSettled<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Concurrency must be a positive integer: ${concurrency}`);
  }

  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await operation(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function throwSettledFailures(
  action: string,
  results: readonly PromiseSettledResult<unknown>[],
): void {
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length === 0) return;
  throw new AggregateError(
    failures.map((failure) => failure.reason),
    `${action} failed for ${failures.length} item(s).`,
  );
}
