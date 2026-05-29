import { RouterProvider } from "@tanstack/react-router"

import { router } from "@/layouts/app-shell/router"

function App() {
  return <RouterProvider router={router} />
}

export default App
