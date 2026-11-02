/**
 * `Promise.all` that waits for every branch before it rethrows. Use it for any fan-out that
 * may run inside an ambient transaction: postgres-js still runs a rejected fan-out's later
 * statements after the transaction ends, on the released connection, inside whichever
 * transaction takes that connection next.
 */
export async function allSettledOrThrow<const T extends readonly unknown[]>(
  values: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(values);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
}
