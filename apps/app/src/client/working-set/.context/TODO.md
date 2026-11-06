# Working-set follow-up

- `driver.ts`: the global driver's debounce and backoff timers and its pagehide
  keepalive listeners can flush a departed account's pending records until another
  account is configured, and in-flight recovery requests outlive the preference
  owner. Define the driver's account lifetime separately from connectivity
  subscription ownership, without discarding same-account PUT revision lineage or
  consuming the next account's queue. Verify same-account remount and
  cross-account transitions with an outstanding request before adding fences.
