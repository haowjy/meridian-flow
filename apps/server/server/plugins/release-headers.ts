import { formatServerProtocol, PROTOCOL_HEADER, RELEASE_HEADER } from "@meridian/contracts/release";
import { type H3Event, setHeader } from "nitro/h3";
import { RELEASE_ID, serverProtocol } from "../lib/release.js";

type ResponseHooks = {
  hooks: {
    hook(name: "request", handler: (event: H3Event) => void): void;
    hook(name: "response", handler: (response: Response) => void): void;
  };
};

export default function releaseHeaders(app: unknown) {
  const { hooks } = app as ResponseHooks;
  const protocol = formatServerProtocol(serverProtocol());
  hooks.hook("request", (event) => {
    setHeader(event, RELEASE_HEADER, RELEASE_ID);
    setHeader(event, PROTOCOL_HEADER, protocol);
  });
  hooks.hook("response", (response) => {
    response.headers.set(RELEASE_HEADER, RELEASE_ID);
    response.headers.set(PROTOCOL_HEADER, protocol);
  });
}
