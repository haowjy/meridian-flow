// @ts-nocheck
/**
 * Context creation type shared by desktop context chrome.
 *
 * Purpose: keep the "new file vs new folder" command shape available after
 * deleting the mobile context browser that originally declared it. The type is
 * UI-local and intentionally tiny because the server mutation owns the payload.
 */
export type ContextCreateKind = "file" | "folder";
