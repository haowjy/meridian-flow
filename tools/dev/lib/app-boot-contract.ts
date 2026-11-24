export type BootRoute = {
  readonly path: string;
  readonly status: number;
  readonly bodyMarker?: string;
};

export const APP_BOOT_ROUTES: readonly BootRoute[] = [
  { path: "/", status: 307 },
  {
    path: "/login",
    status: 200,
    bodyMarker: "Get the story out of your head and onto the page.",
  },
];

export function routeContractFailure(input: {
  readonly path: string;
  readonly expectedStatus: number;
  readonly actualStatus: number;
  readonly body: string;
  readonly bodyMarker?: string;
}): string | undefined {
  if (input.actualStatus !== input.expectedStatus) {
    return `${input.path}: expected ${input.expectedStatus}, received ${input.actualStatus}`;
  }
  if (input.bodyMarker && !input.body.includes(input.bodyMarker)) {
    return `${input.path}: ${input.actualStatus} response did not contain marker ${JSON.stringify(input.bodyMarker)}`;
  }
  return undefined;
}
