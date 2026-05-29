import {
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router"

import { routeTree } from "./routes"

export type CreateAppRouterOptions = {
  /** Storybook / tests — omit for browser history. */
  initialEntries?: string[]
}

export function createAppRouter(options?: CreateAppRouterOptions) {
  const history = options?.initialEntries
    ? createMemoryHistory({ initialEntries: options.initialEntries })
    : undefined

  return createRouter({
    routeTree,
    history,
  })
}

export const router = createAppRouter()

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
