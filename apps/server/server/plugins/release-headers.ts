/** Every API answer, rendered errors included, says which release and protocol the server is. */
import { formatServerProtocol, PROTOCOL_HEADER, RELEASE_HEADER } from "@meridian/contracts/release";
import { RELEASE_ID, serverProtocol } from "../lib/release.js";

type ResponseHooks = {
  hooks: { hook(name: "response", handler: (response: Response) => void): void };
};

export default function releaseHeaders(app: unknown) {
  const protocol = formatServerProtocol(serverProtocol());
  (app as ResponseHooks).hooks.hook("response", (response) => {
    response.headers.set(RELEASE_HEADER, RELEASE_ID);
    response.headers.set(PROTOCOL_HEADER, protocol);
  });
}
