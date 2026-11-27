export function pathLeafName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export type CollapsedBreadcrumb<T> = {
  leading: T[];
  elided: boolean;
  trailing: T[];
};

export function collapseBreadcrumbSegments<T>(segments: T[]): CollapsedBreadcrumb<T> {
  if (segments.length <= 4) {
    return { leading: segments, elided: false, trailing: [] };
  }
  return { leading: segments.slice(0, 1), elided: true, trailing: segments.slice(-2) };
}
