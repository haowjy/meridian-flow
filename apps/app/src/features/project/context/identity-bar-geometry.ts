/**
 * Every child of the identity row (crumbs, edit field, commit/cancel buttons,
 * chips) is a 22px box (`h-5.5`, borders included: text-sm's 20px line + 1px
 * border top and bottom), so the rest state and the edit state are the same
 * height and toggling edit never shifts the row.
 */
export const IDENTITY_BAR_BOX_CLASS = "h-5.5";
