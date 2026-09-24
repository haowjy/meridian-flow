/** Project creation lives on its own destination, apart from the library. */
import { createFileRoute } from "@tanstack/react-router";
import { NewProjectView } from "@/features/home/NewProjectView";

export const Route = createFileRoute("/_authenticated/projects/new")({
  component: NewProjectView,
});
