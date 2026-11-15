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

const REFUSED = new BlockList();
const refuse = (network: string, prefix: number, family: "ipv4" | "ipv6") =>
  REFUSED.addSubnet(network, prefix, family);

refuse("0.0.0.0", 8, "ipv4");
refuse("10.0.0.0", 8, "ipv4");
refuse("100.64.0.0", 10, "ipv4");
refuse("127.0.0.0", 8, "ipv4");
refuse("169.254.0.0", 16, "ipv4");
refuse("172.16.0.0", 12, "ipv4");
refuse("192.0.0.0", 24, "ipv4");
refuse("192.168.0.0", 16, "ipv4");
refuse("198.18.0.0", 15, "ipv4");
refuse("224.0.0.0", 3, "ipv4"); // multicast, reserved and broadcast
refuse("::", 128, "ipv6");
refuse("::1", 128, "ipv6");
refuse("64:ff9b::", 96, "ipv6"); // NAT64 embeds an IPv4 address
refuse("2002::", 16, "ipv6"); // 6to4 embeds an IPv4 address
refuse("fc00::", 7, "ipv6");
refuse("fe80::", 10, "ipv6");
refuse("ff00::", 8, "ipv6");

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is judged as the IPv4 address it carries. */
function ipv4Carried(address: string): string | null {
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1] ?? null;
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const high = Number.parseInt(hex[1] ?? "", 16);
  const low = Number.parseInt(hex[2] ?? "", 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const carried = family === 6 ? ipv4Carried(address) : null;
  const effective = carried ?? address;
  return !REFUSED.check(effective, isIP(effective) === 6 ? "ipv6" : "ipv4");
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

const dial = buildConnector({ lookup: publicLookup as never });

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
  connectTimeout: 10_000,
  headersTimeout: 10_000,
  bodyTimeout: 10_000,
});
