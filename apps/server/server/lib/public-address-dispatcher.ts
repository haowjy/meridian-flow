/**
 * An undici dispatcher that connects only to public internet addresses, for every request to an
 * address a writer or a model chose (the image proxy, MCP servers).
 *
 * The check runs inside the connection, on the address actually dialled, so a name that resolves
 * to a private address on a later hop or a later connection is refused too. A URL check before
 * the request cannot give that. Scheme, port and redirect policy belong to the caller.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector } from "undici";

// Only global unicast is public. IPv4 is everything outside the special-purpose blocks below. IPv6
// is allowed only inside 2000::/3 (so NAT64, IPv4-mapped and IPv4-compatible forms, unique-local,
// link-local and multicast all fall outside it), minus the blocks inside it that embed or route
// to non-public space. A list of refusals would miss whatever nobody listed.
const IPV4_SPECIAL = new BlockList();
const ipv4Special = (network: string, prefix: number) =>
  IPV4_SPECIAL.addSubnet(network, prefix, "ipv4");
ipv4Special("0.0.0.0", 8);
ipv4Special("10.0.0.0", 8);
ipv4Special("100.64.0.0", 10);
ipv4Special("127.0.0.0", 8);
ipv4Special("169.254.0.0", 16);
ipv4Special("172.16.0.0", 12);
ipv4Special("192.0.0.0", 24);
ipv4Special("192.0.2.0", 24);
ipv4Special("192.168.0.0", 16);
ipv4Special("198.18.0.0", 15);
ipv4Special("198.51.100.0", 24);
ipv4Special("203.0.113.0", 24);
ipv4Special("224.0.0.0", 3); // multicast, reserved and broadcast

const IPV6_GLOBAL = new BlockList();
IPV6_GLOBAL.addSubnet("2000::", 3, "ipv6");

const IPV6_SPECIAL = new BlockList();
const ipv6Special = (network: string, prefix: number) =>
  IPV6_SPECIAL.addSubnet(network, prefix, "ipv6");
ipv6Special("2001::", 32); // Teredo
ipv6Special("2001:2::", 48); // benchmarking
ipv6Special("2001:10::", 28); // ORCHID
ipv6Special("2001:db8::", 32); // documentation
ipv6Special("2002::", 16); // 6to4 embeds an IPv4 address
ipv6Special("3fff::", 20); // documentation

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !IPV4_SPECIAL.check(address, "ipv4");
  if (family === 6) {
    return IPV6_GLOBAL.check(address, "ipv6") && !IPV6_SPECIAL.check(address, "ipv6");
  }
  return false;
}

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`${host} is not a public address`);
    this.name = "PrivateAddressError";
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A name is refused when ANY address it resolves to is not public, so a mixed answer cannot be picked from. */
function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new PrivateAddressError(hostname), []);
    }
    if (options.all) return callback(null, addresses);
    const [first] = addresses;
    return callback(null, first?.address ?? "", first?.family);
  });
}

/**
 * HTTP/1.1 only, and the connector is where that is decided: it offers the ALPN protocols, and an
 * Agent with its own `connect` speaks whatever the socket negotiated, whatever the Agent's own
 * `allowH2` says. undici 8.12.4 offers HTTP/2 by default, and aborting a request before its
 * response headers arrive (an MCP session closing its event stream, a deadline) can leave a
 * stream Node tracks but undici does not: when the server's reply lands after the abort Node
 * wraps it in a new stream that nothing listens to, and the idle-socket close four seconds later
 * throws its error as an uncaught exception that ends the process (nodejs/undici#6143, open;
 * fix proposed in #6147). Neither caller needs multiplexing. Remove `allowH2: false` once an
 * undici release has that fix.
 */
const dial = buildConnector({ lookup: publicLookup as never, timeout: 10_000, allowH2: false });

/** No proxy from the environment: this Agent reads none. */
export const publicAddressDispatcher = new Agent({
  // `lookup` never runs for an IP literal, so a literal is judged here.
  connect: (options, callback) => {
    const host = options.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
      callback(new PrivateAddressError(host), null);
      return;
    }
    dial(options, callback);
  },
  headersTimeout: 10_000,
  bodyTimeout: 10_000,
});
