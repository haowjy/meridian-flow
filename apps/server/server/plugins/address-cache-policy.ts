import { type H3Event, setHeader } from "nitro/h3";

type AddressResponseHooks = {
  hooks: {
    hook(name: "request", handler: (event: H3Event) => void): void;
    hook(name: "response", handler: (response: Response, event: H3Event) => void): void;
  };
};

function isAddressRequest(event: H3Event): boolean {
  const path = new URL(event.req.url).pathname;
  return /^\/api\/projects\/[^/]+\/context\/[^/]+\/address$/.test(path);
}

export default function addressCachePolicy(app: unknown) {
  const { hooks } = app as AddressResponseHooks;
  hooks.hook("request", (event) => {
    if (isAddressRequest(event)) setHeader(event, "Cache-Control", "private, no-store");
  });
  hooks.hook("response", (response, event) => {
    // keep: set this header at both H3 stages: a throw discards event headers, and a successful object response takes them only from the prepared event
    if (isAddressRequest(event)) response.headers.set("Cache-Control", "private, no-store");
  });
}
