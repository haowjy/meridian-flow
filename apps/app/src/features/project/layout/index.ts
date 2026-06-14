// @ts-nocheck
/**
 * Public exports for the flat-grid project layout primitive.
 *
 * Purpose: expose production layout primitives: surface prefs, pure placement,
 * grid topology, flat surface rendering, resizing, and shared contracts. Key
 * decision: prototype/demo mounts stay out of this barrel so app code cannot
 * depend on exploratory scaffolding by accident.
 */
export * from "./desktop-layout";
export * from "./placement";
export * from "./ResizeHandle";
export * from "./SlotGrid";
export * from "./surface-prefs-store";
export * from "./types";
