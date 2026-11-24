import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./public-address-dispatcher.js";

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:a00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "64:ff9b::808:808",
    "2002:7f00:1::",
    "64:ff9b:1::a9fe:a9fe",
    "::ffff:8.8.8.8",
    "::7f00:1",
    "::8.8.8.8",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1",
    "fec0::1",
    "100::1",
    "3fff::1",
    "192.0.2.1",
    "203.0.113.9",
    "not an address",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001::200e",
    "2001:4860:4860::8888",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});
