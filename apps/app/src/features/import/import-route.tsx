/** What the router tells import: which report is the Editor's address, and how to move between them. */
import { createContext, type ReactNode, useContext } from "react";

export type ImportRoute = {
  /** The import whose report the Editor address names, if any. */
  activeImportId: string | null;
  /** Navigate to a report (its own address, so Back works). */
  openReport: (importId: string) => void;
  /** Leave the report for the Editor's last document or the chooser. */
  closeReport: () => void;
  /** Show a folder in the Files browser (the phone's destination after Import). */
  showFolder: (scheme: string, path: string) => void;
};

const NO_ROUTE: ImportRoute = {
  activeImportId: null,
  openReport: () => {},
  closeReport: () => {},
  showFolder: () => {},
};

const ImportRouteContext = createContext<ImportRoute>(NO_ROUTE);

export function ImportRouteProvider({
  value,
  children,
}: {
  value: ImportRoute;
  children: ReactNode;
}) {
  return <ImportRouteContext.Provider value={value}>{children}</ImportRouteContext.Provider>;
}

export function useImportRoute(): ImportRoute {
  return useContext(ImportRouteContext);
}
