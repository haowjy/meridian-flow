/** Shared hit-area and row geometry for visible context-tree overflow controls. */

export const contextTreeRowClassName =
  "h-8 [@media(hover:none)]:h-11 [@media(pointer:coarse)]:h-11";

export const contextTreeOverflowTriggerClassName =
  "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100";

export const mobileContextTreeOverflowTriggerClassName = "size-11 opacity-100";
