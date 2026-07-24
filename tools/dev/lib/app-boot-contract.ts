/** Exact public-route contract exercised by the app dev-boot smoke. */

export const APP_BOOT_ROUTES = [
  { path: "/", status: 307 },
  {
    path: "/login",
    status: 200,
    bodyMarker: "Get the story out of your head and onto the page.",
  },
] as const;

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
    return `${input.path}: ${input.actualStatus} response did not contain app marker ${JSON.stringify(input.bodyMarker)}`;
  }
  return undefined;
}
