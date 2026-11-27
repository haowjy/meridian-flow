import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector } from "undici";
import { OUTBOUND_CONNECT_OPTIONS } from "./outbound-http1";

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
ipv4Special("224.0.0.0", 3);

const IPV6_GLOBAL = new BlockList();
IPV6_GLOBAL.addSubnet("2000::", 3, "ipv6");

const IPV6_SPECIAL = new BlockList();
const ipv6Special = (network: string, prefix: number) =>
  IPV6_SPECIAL.addSubnet(network, prefix, "ipv6");
ipv6Special("2001::", 32);
ipv6Special("2001:2::", 48);
ipv6Special("2001:10::", 28);
ipv6Special("2001:db8::", 32);
ipv6Special("2002::", 16);
ipv6Special("3fff::", 20);

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

const dial = buildConnector({
  ...OUTBOUND_CONNECT_OPTIONS,
  lookup: publicLookup as never,
  timeout: 10_000,
});

export const publicAddressDispatcher = new Agent({
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
