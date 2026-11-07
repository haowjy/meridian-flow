import { Link } from "@tanstack/react-router";

export function NotFound() {
  return (
    <main className="notice" data-ui-theme="dark">
      <h1>This page doesn’t exist.</h1>
      <Link to="/">Go to Meridian Flow</Link>
    </main>
  );
}
