import * as React from "react"
import { RouterProvider } from "@tanstack/react-router"

import { createAppRouter } from "./router"

type AppRouterStoryProps = {
  initialPath: string
}

/** Storybook wrapper — memory history + full app route tree. */
function AppRouterStory({ initialPath }: AppRouterStoryProps) {
  const router = React.useMemo(
    () => createAppRouter({ initialEntries: [initialPath] }),
    [initialPath],
  )

  return <RouterProvider router={router} />
}

export { AppRouterStory }
