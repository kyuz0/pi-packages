import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const prohibitedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  prohibitedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  prohibitedAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address, family = isIP(address)) {
  if (family === 4) return !prohibitedAddresses.check(address, "ipv4");
  if (family === 6) return !prohibitedAddresses.check(address, "ipv6");
  return false;
}

export function normalizePublicHostname(value) {
  const hostname = value.trim().replace(/\.$/, "").toLowerCase();
  if (
    !hostname ||
    hostname.length > 253 ||
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname.split(".").some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return undefined;
  }
  return hostname;
}

export async function validatePublicHostname(
  value,
  resolve = (hostname) => lookup(hostname, { all: true, verbatim: true }),
) {
  const hostname = normalizePublicHostname(value);
  if (!hostname) return undefined;
  // The outer allowlist gateway owns DNS in proxy-only containers. A model
  // grant cannot bypass its exact hostname/port policy. Ordinary installations
  // and unrestricted containers retain public-address validation below.
  if (process.env.PI_SANDBOX_CONTAINER === "1" &&
      process.env.SANDBOX_NETWORK_MODE === "allowlist" &&
      process.env.HTTPS_PROXY === "http://127.0.0.1:3128") return hostname;
  try {
    const addresses = await resolve(hostname);
    return addresses.length > 0 &&
      addresses.every(({ address, family }) =>
        isPublicAddress(address, family),
      )
      ? hostname
      : undefined;
  } catch {
    return undefined;
  }
}
