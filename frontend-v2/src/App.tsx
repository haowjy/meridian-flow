import { ThemeProvider } from "@/components/theme-provider"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import { Toaster } from "@/components/ui/sonner"

function App() {
  return (
    <ThemeProvider defaultTheme="system">
      <div className="flex min-h-screen items-center justify-center">
        <div className="grid gap-4 text-center">
          <h1 className="text-3xl font-bold font-sans">Meridian v2</h1>
          <p className="text-muted-foreground">Design system loaded.</p>
          <div className="flex justify-center">
            <ThemeToggle />
          </div>
        </div>
      </div>
      <Toaster />
    </ThemeProvider>
  )
}

export default App
