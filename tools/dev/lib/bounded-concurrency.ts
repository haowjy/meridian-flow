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
  labels: readonly string[] = [],
): void {
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [{ result, index }] : [],
  );
  if (failures.length === 0) return;
  throw new AggregateError(
    failures.map(({ result }) => result.reason),
    `${action} failed for ${failures.length} item(s): ${failures
      .map(({ result, index }) => {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        return `${labels[index] ?? `item ${index + 1}`} (${reason})`;
      })
      .join(", ")}.`,
  );
}
