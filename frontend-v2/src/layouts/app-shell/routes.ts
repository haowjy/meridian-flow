import {
  createRootRoute,
  createRoute,
  redirect,
} from "@tanstack/react-router"

import {
  DEMO_DOCUMENT_PATH,
  DEMO_PROJECT_ID,
  DEMO_THREAD_ID,
} from "../shared/mock-data"
import { AppRoot } from "./app-root"

function redirectToDefaultConverse() {
  throw redirect({
    to: "/projects/$projectId/converse/$threadId",
    params: {
      projectId: DEMO_PROJECT_ID,
      threadId: DEMO_THREAD_ID,
    },
  })
}

const rootRoute = createRootRoute({
  component: AppRoot,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: redirectToDefaultConverse,
})

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  beforeLoad: redirectToDefaultConverse,
})

const projectIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "projects/$projectId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$projectId/converse/$threadId",
      params: {
        projectId: params.projectId,
        threadId: DEMO_THREAD_ID,
      },
    })
  },
})

/** URL marker only — AppShell stays mounted; visibility is CSS-driven. */
const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "projects/$projectId/agents",
  component: () => null,
})

const converseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "projects/$projectId/converse/$threadId",
  component: () => null,
})

const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "projects/$projectId/studio/$",
  component: () => null,
  params: {
    parse: (raw) => ({
      ...raw,
      _splat: raw._splat ? decodeURIComponent(raw._splat) : DEMO_DOCUMENT_PATH,
    }),
    stringify: (params) => ({
      ...params,
      _splat: encodeURIComponent(params._splat),
    }),
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  notFoundRoute,
  projectIndexRoute,
  agentsRoute,
  converseRoute,
  studioRoute,
])

export {
  routeTree,
  rootRoute,
  agentsRoute,
  converseRoute,
  studioRoute,
}
