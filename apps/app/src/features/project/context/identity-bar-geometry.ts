/**
 * Identity-bar geometry contract, shared by the band (DocumentIdentityBar)
 * and every child that must fit inside it (crumbs, edit field, commit/cancel
 * buttons, chips).
 *
 * The band is a strip of one line at least 28px tall = a 22px content area
 * centred between 3px above and 3px below. It stays one line, and so the same
 * height, until the review controls wrap to a line of their own because the
 * path and the controls do not fit together (DocumentIdentityBar). Centring matters because the band takes the
 * draft tint under review, where an off-centre row shows. Every child is a 22px box (`h-5.5`, borders included —
 * text-sm's 20px line + 1px border top/bottom). Because rest state (crumbs +
 * chip) and edit state (field + ✓/× buttons) are same-height boxes inside the
 * same band, toggling edit mode never shifts the toolbar or prose below.
 */
export const IDENTITY_BAR_BAND_CLASS = "min-h-7";
export const IDENTITY_BAR_BOX_CLASS = "h-5.5";
