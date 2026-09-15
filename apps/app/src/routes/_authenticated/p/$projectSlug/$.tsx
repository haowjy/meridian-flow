/** Child destination matching; the project parent owns the persistent workspace. */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/p/$projectSlug/$")({ component: () => null });
