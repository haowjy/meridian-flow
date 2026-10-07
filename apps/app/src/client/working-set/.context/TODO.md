# Working-set follow-up

- `driver.ts` (`schedule`, `sweep`, and `browserDriver`): the global driver's
  debounce/backoff timers and pagehide/hidden-visibility keepalive listeners can
  flush a departed account's pending records until another account is configured.
  In-flight recovery GETs and PUTs also outlive the preference owner. Define the
  driver's account lifetime separately from connectivity subscription ownership;
  cancel departed-account scheduling and prevent stale recovery adoption without
  discarding same-account PUT revision lineage or consuming the next account's
  queue. Verify same-account remount and cross-account transitions with an
  outstanding request before adding lifetime fences.
