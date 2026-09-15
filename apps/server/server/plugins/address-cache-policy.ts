/** Private address caching at both H3 response stages, including rendered errors. */
import { type H3Event, setHeader } from "nitro/h3";

type AddressResponseHooks = {
  hooks: {
    hook(name: "request", handler: (event: H3Event) => void): void;
    hook(name: "response", handler: (response: Response, event: H3Event) => void): void;
  };
};

function isAddressRequest(event: H3Event): boolean {
  const path = new URL(event.req.url).pathname;
  return (
    /^\/api\/project-addresses\/[^/]+$/.test(path) ||
    /^\/api\/projects\/[^/]+\/context\/[^/]+\/address$/.test(path)
  );
}

export default function addressCachePolicy(app: unknown) {
  const { hooks } = app as AddressResponseHooks;
  hooks.hook("request", (event) => {
    if (isAddressRequest(event)) setHeader(event, "Cache-Control", "private, no-store");
  });
  hooks.hook("response", (response, event) => {
    // H3 discards ordinary event headers when a handler throws. Conversely,
    // successful object responses take their headers from the prepared event.
    if (isAddressRequest(event)) response.headers.set("Cache-Control", "private, no-store");
  });
}
