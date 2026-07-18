/**
 * Identity-bar geometry contract, shared by the band (DocumentIdentityBar)
 * and every child that must fit inside it (crumbs, edit field, commit/cancel
 * buttons, chips).
 *
 * The band is a fixed-height strip: 26px total = 4px breathing room above +
 * a 22px content area. Every child is a 22px box (`h-5.5`, borders included —
 * text-sm's 20px line + 1px border top/bottom). Because rest state (crumbs +
 * chip) and edit state (field + ✓/× buttons) are same-height boxes inside the
 * same fixed band, toggling edit mode never shifts the toolbar or prose below.
 */
export const IDENTITY_BAR_BAND_CLASS = "h-6.5 pt-1";
export const IDENTITY_BAR_BOX_CLASS = "h-5.5";
