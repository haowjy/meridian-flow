/** One opt-in switch failure record, projected by the source control and destination boundary. */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { ScreenKey } from "../shell/screens";
import type { NavigationSettlement, ProjectNavigationTicket } from "./project-navigation";

type Origin = "rail" | "header";
export type SwitchSource = { kind: "rail"; screen: ScreenKey } | { kind: "header"; claim: number };
type SwitchFailure = {
  location: "source" | "destination";
  source: SwitchSource;
  ticket: ProjectNavigationTicket;
};
const FailureContext = createContext<{
  failures: Partial<Record<Origin, SwitchFailure>>;
  clear: (origin?: Origin) => void;
  report: (result: NavigationSettlement, source: SwitchSource) => void;
} | null>(null);
export function DocumentSwitchFailureProvider({
  children,
  entryKey,
}: {
  children: ReactNode;
  entryKey: string;
}) {
  const [failures, setFailures] = useState<Partial<Record<Origin, SwitchFailure>>>({});
  useEffect(
    () =>
      setFailures((previous) =>
        previous.rail?.location === "source" && previous.rail.ticket.key !== entryKey
          ? { ...previous, rail: undefined }
          : previous,
      ),
    [entryKey],
  );
  return (
    <FailureContext.Provider
      value={{
        failures,
        clear: (origin) =>
          setFailures((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(
                ([key, failure]) => key !== origin && failure?.location === "source",
              ),
            ),
          ),
        report: (result, source) => {
          if (result.kind !== "failed") return;
          setFailures((previous) => ({
            ...previous,
            [source.kind]: {
              location: result.stage === "workspace-commit" ? "destination" : "source",
              source,
              ticket: result.ticket,
            },
          }));
        },
      }}
    >
      {children}
    </FailureContext.Provider>
  );
}
export function useDocumentSwitchFailures() {
  const context = useContext(FailureContext);
  if (!context) throw new Error("Document switch failure owner is required");
  return context;
}
export function railFailure(
  failures: Partial<Record<Origin, SwitchFailure>>,
  key: string,
): ScreenKey | null {
  const failed = failures.rail;
  return failed?.location === "source" && failed.ticket.key === key && failed.source.kind === "rail"
    ? failed.source.screen
    : null;
}
export function headerFailure(failures: Partial<Record<Origin, SwitchFailure>>, revision: number) {
  const failed = failures.header;
  return (
    failed?.location === "source" &&
    failed.source.kind === "header" &&
    failed.source.claim === revision
  );
}
export function destinationFailure(
  failures: Partial<Record<Origin, SwitchFailure>>,
  href: string,
  key: string,
) {
  return Object.values(failures).some(
    (failed) =>
      failed?.location === "destination" &&
      failed.ticket.href === href &&
      failed.ticket.key === key,
  );
}
