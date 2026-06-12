/**
 * Purpose: Collects runtime contracts behind the @meridian/contracts/runtime entrypoint.
 * Why independent: Runtime ID aliases and configuration DTOs are shared JSON-natural boundaries.
 * Barrel: re-exports runtime ID aliases and shared usage accounting DTOs.
 */
export * from "./ids.js";
export * from "./usage.js";
