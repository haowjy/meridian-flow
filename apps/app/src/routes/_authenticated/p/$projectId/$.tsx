import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/p/$projectId/$")({ component: () => null });
