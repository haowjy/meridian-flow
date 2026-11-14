/** A package's files: package-relative path to UTF-8 text. */
export type SkillFiles = Record<string, string>;

export interface ExportedMarsDirectory {
  files: SkillFiles;
}
