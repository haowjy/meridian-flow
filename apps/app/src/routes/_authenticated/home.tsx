import { createFileRoute } from "@tanstack/react-router";

import { HomeView } from "@/features/home/HomeView";

export const Route = createFileRoute("/_authenticated/home")({
  component: Home,
});

/** Composer home for starting a new project or browsing recent work. */
function Home() {
  return <HomeView />;
}
