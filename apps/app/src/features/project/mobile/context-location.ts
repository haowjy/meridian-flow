// @ts-nocheck
/**
 * context-location — pure helpers describing the phone shell's drilled-in
 * context location (Files › scheme › folders › file) for the top-bar
 * breadcrumb.
 *
 * Key decision: folder paths follow the route's URL convention — absolute
 * `/a/b` strings, with `""` meaning the scheme root (empty search params are
 * stripped, so the scheme root has no `folder` param at all). Everything here
 * is pure string/array logic so it unit-tests without the shell or Lingui.
 */

/** One ancestor folder of the current context location. */
export type FolderCrumb = {
  /** Display leaf name of the folder (`b` for `/a/b`). */
  name: string;
  /** Absolute folder path to navigate to (`/a/b`). */
  path: string;
};

/**
 * Ancestor chain for a folder param, shallowest first:
 * `/a/b` → `[{name: "a", path: "/a"}, {name: "b", path: "/a/b"}]`.
 * Scheme root (`null` / `""` / `/`) → `[]`.
 */
export function folderAncestry(folder: string | null): FolderCrumb[] {
  const names = (folder ?? "").split("/").filter(Boolean);
  return names.map((name, index) => ({
    name,
    path: `/${names.slice(0, index + 1).join("/")}`,
  }));
}

/** Leaf display name of a file path: `/notes/file.md` → `file.md`. */
export function pathLeafName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * Middle-truncated view of a breadcrumb trail. When `elided` is true the
 * renderer shows `leading › … › trailing` (first segment kept, last two
 * kept); otherwise `leading` is the whole trail and `trailing` is empty.
 */
export type CollapsedBreadcrumb<T> = {
  leading: T[];
  /** True when middle segments were dropped and an ellipsis should render. */
  elided: boolean;
  trailing: T[];
};

/**
 * Breadcrumb middle-truncation: trails of ≤4 segments render whole; deeper
 * trails keep the first segment (the "Files" root — the only stable anchor)
 * and the last two (parent + current), eliding the middle. The scheme sits
 * second in the trail, so on deep paths it elides along with intermediate
 * folders — intended: on a phone-width bar the root and the immediate
 * neighborhood matter most. Per-segment width capping is the renderer's
 * job; this only bounds the segment *count*.
 */
export function collapseBreadcrumbSegments<T>(segments: T[]): CollapsedBreadcrumb<T> {
  if (segments.length <= 4) {
    return { leading: segments, elided: false, trailing: [] };
  }
  return { leading: segments.slice(0, 1), elided: true, trailing: segments.slice(-2) };
}
