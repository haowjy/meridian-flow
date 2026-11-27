// A request during a run gets a run after it, never the run in flight: that one may have read
// before the request.
export function singleFlight<T = void>(
  run: (requests: readonly T[]) => Promise<unknown>,
): (request: T) => void {
  let running = false;
  let gathered: T[] = [];
  const start = (requests: readonly T[]) => {
    running = true;
    void run(requests).finally(() => {
      running = false;
      const next = gathered;
      gathered = [];
      if (next.length > 0) start(next);
    });
  };
  return (request) => {
    if (running) gathered.push(request);
    else start([request]);
  };
}
