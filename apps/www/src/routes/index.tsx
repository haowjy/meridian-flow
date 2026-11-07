import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { LandingPage } from "~/features/landing/LandingPage";

const PRODUCTION_APP_ORIGIN = "https://app.meridian-flow.com";
const DEV_APP_ORIGIN = "https://app.meridian.localhost";

const getAppOrigin = createServerFn({ method: "GET" }).handler(
  () =>
    process.env.MERIDIAN_APP_ORIGIN ||
    (process.env.NODE_ENV === "production" ? PRODUCTION_APP_ORIGIN : DEV_APP_ORIGIN),
);

export const Route = createFileRoute("/")({
  loader: () => getAppOrigin(),
  // Before first paint, so the hero never flashes the stacked layout that no-script
  // and reduced-motion visitors get. If the bundle never starts the film, stack after all.
  head: () => ({
    links: [{ rel: "canonical", href: "https://www.meridian-flow.com/" }],
    scripts: [
      {
        children:
          "if(!matchMedia('(prefers-reduced-motion: reduce)').matches){const h=document.documentElement;h.classList.add('cine');setTimeout(()=>{if(!h.classList.contains('film-ready'))h.classList.remove('cine')},6000)}",
      },
    ],
  }),
  component: HomeComponent,
});

function HomeComponent() {
  return <LandingPage appOrigin={Route.useLoaderData()} />;
}
