import type { ErrorComponentProps } from "@tanstack/react-router";
import { Link, useRouter } from "@tanstack/react-router";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();
  console.error("DefaultCatchBoundary Error:", error);

  return (
    <main className="notice" data-ui-theme="dark">
      <h1>This page didn’t load.</h1>
      <button type="button" onClick={() => router.invalidate()}>
        Try again
      </button>
      <Link to="/">Go to Meridian Flow</Link>
    </main>
  );
}
