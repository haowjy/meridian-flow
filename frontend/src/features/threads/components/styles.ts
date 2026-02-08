/**
 * Base Card className for user turn bubbles.
 * Used by UserTurn (display) and EditTurnInput (edit) - keep in sync.
 */
export const threadSurfacePadding = "px-2.5 py-1.5";

/**
 * Shared padding for collapsible tool block headers.
 * Keeps assistant tool rows aligned with turn composer spacing.
 */
export const threadToolHeaderPadding = "px-2.5 py-1.5";

/**
 * Shared padding for expanded tool block content.
 */
export const threadToolContentPadding = "px-2.5 py-2";

export const userTurnCardBase = `${threadSurfacePadding} min-w-0 max-w-[95%] thread-message thread-message--user`;
