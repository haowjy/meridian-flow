/**
 * Purpose: Collects golden thread fixture modules for protocol projection tests.
 * Why independent: Golden fixtures are shared contract examples used to keep orchestrator events and AG-UI streams aligned across packages.
 * Barrel: re-exports simple text/tool turn fixtures and fixture builders.
 */
export * from "./simple-text-turn.agui.js";
export * from "./simple-text-turn.js";
export * from "./simple-tool-turn.agui.js";
export * from "./simple-tool-turn.js";
export * from "./turn-fixture.js";
