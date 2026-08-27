/** Document-scoped safe-area geometry for compact Radix surfaces. */
import { createContext, type ReactNode, useContext, useState } from "react";

const DensityCollisionBoundaryContext = createContext<Element | null>(null);

export function DensityPopoverCollisionProvider({ children }: { children: ReactNode }) {
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);

  return (
    <DensityCollisionBoundaryContext value={boundary}>
      <div
        ref={setBoundary}
        aria-hidden="true"
        className="safe-area-collision-boundary"
        data-safe-area-collision-boundary=""
      />
      {children}
    </DensityCollisionBoundaryContext>
  );
}

/** Radix collision policy for compact density surfaces, not generic popovers. */
export function useDensityPopoverCollisionProps() {
  const collisionBoundary = useContext(DensityCollisionBoundaryContext);
  return collisionBoundary
    ? { collisionBoundary, collisionPadding: 8 as const }
    : { collisionPadding: 8 as const };
}
