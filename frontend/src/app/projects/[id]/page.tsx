// Note: params must be awaited in Next.js 16
export default async function ProjectWorkspace({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Project Workspace: {id}</h1>
        <p className="mt-2 text-muted-foreground">Coming in Phase 4</p>
      </div>
    </div>
  )
}
