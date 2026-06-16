/**
 * library-selection — discriminated union for the Library master-detail list.
 *
 * Selection keys are slugs scoped by kind because agent, skill, and package
 * slugs share one namespace in the inventory payload but render differently.
 */
export type LibrarySelection =
  | { kind: "agent"; slug: string }
  | { kind: "skill"; slug: string }
  | { kind: "package"; slug: string }
  | { kind: "install" };

export function selectionKey(selection: LibrarySelection): string {
  if (selection.kind === "install") return "install";
  return `${selection.kind}:${selection.slug}`;
}
