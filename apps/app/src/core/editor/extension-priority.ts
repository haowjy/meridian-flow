// TipTap orders plugins, keymaps included, by these, highest first:
// - undo: the writer's recovery over LLM writes, so no surface may shadow it;
// - chrome kernel: it resolves the context everything below it reads;
// - object physics: the deepest thing in the document, never the outermost thing on screen.
export const EXTENSION_PRIORITY = {
  undoRedo: 1100,
  chromeKernel: 1050,
  objectPhysics: 1040,
  blockDrag: 1030,
} as const;
