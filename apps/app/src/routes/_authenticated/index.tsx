// @ts-nocheck
import { createFileRoute } from "@tanstack/react-router";

import { HomeView } from "@/features/home/HomeView";

export const Route = createFileRoute("/_authenticated/")({
  component: Home,
});

/** Authenticated home at `/`, inheriting auth/session shell from the pathless layout. */
function Home() {
  return <HomeView />;
}
