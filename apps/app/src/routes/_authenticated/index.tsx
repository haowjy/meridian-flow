import { createFileRoute } from "@tanstack/react-router";
import { ProjectLibrary } from "@/features/home/ProjectLibrary";

export const Route = createFileRoute("/_authenticated/")({ component: ProjectLibrary });
