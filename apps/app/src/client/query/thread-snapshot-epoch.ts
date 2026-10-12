/** Snapshot errors retain the bind under which the request began, not the route's later bind. */
const epochs = new WeakMap<object, number>();
export async function withThreadSnapshotEpoch<T>(
  epoch: number,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const stamped = error instanceof Object ? error : new Error(String(error));
    epochs.set(stamped, epoch);
    throw stamped;
  }
}
export function threadSnapshotErrorEpoch(error: unknown): number | undefined {
  return error instanceof Object ? epochs.get(error) : undefined;
}
