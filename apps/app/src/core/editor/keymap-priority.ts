// Undo stays highest: it is the writer's recovery over LLM writes, and no surface may shadow it.
export const KEYMAP_PRIORITY = {
  undoRedo: 1100,
  chromeKernel: 1050,
  objectPhysics: 1040,
  blockDrag: 1030,
} as const;
