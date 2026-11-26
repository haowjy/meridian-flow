import { readSegment } from "@meridian/contracts/protocol";

export type FolderCrumb = {
  name: string;
  path: string;
};

export function folderAncestry(folder: string | null): FolderCrumb[] {
  const names = (folder ?? "").split("/").filter(Boolean);
  return names.map((name, index) => ({
    name: readSegment(name).name,
    path: `/${names.slice(0, index + 1).join("/")}`,
  }));
}

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
