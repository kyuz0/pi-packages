import assert from "node:assert/strict";
import test from "node:test";
import { getPiSandboxConfigPath } from "../src/config.ts";
import { createDefaultPolicy, toSandboxRuntimeConfig } from "../src/policy.ts";
import { validatePublicHostname } from "../src/network-policy.mjs";

test("container integration keeps default isolation and delegates DNS only to the configured gateway", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.PI_SANDBOX_CONTAINER;
    assert.equal(toSandboxRuntimeConfig(createDefaultPolicy("/tmp/example")).enableWeakerNestedSandbox, undefined);
    assert.notEqual(getPiSandboxConfigPath("/tmp/home"), "/opt/pi-security/config/sandbox.json");
    const unavailable = async () => { throw new Error("No direct DNS"); };
    assert.equal(await validatePublicHostname("example.com", unavailable), undefined);
    process.env.PI_SANDBOX_CONTAINER = "1";
    process.env.SANDBOX_NETWORK_MODE = "allowlist";
    process.env.HTTPS_PROXY = "http://127.0.0.1:3128";
    assert.equal(toSandboxRuntimeConfig(createDefaultPolicy("/tmp/example")).enableWeakerNestedSandbox, true);
    assert.equal(getPiSandboxConfigPath(), "/opt/pi-security/config/sandbox.json");
    assert.equal(await validatePublicHostname("Example.COM.", unavailable), "example.com");
    for (const invalid of ["127.0.0.1", "https://example.com/path", "example.com:443", "bad host.example", "example.com\nattack"]) {
      assert.equal(await validatePublicHostname(invalid, unavailable), undefined);
    }
    process.env.HTTPS_PROXY = "http://untrusted.example:3128";
    assert.equal(await validatePublicHostname("example.com", unavailable), undefined);
    process.env.HTTPS_PROXY = "http://127.0.0.1:3128";
    process.env.SANDBOX_NETWORK_MODE = "unrestricted";
    assert.equal(await validatePublicHostname("example.com", unavailable), undefined);
    assert.equal(await validatePublicHostname("example.com", async () => [{ address: "127.0.0.1", family: 4 }]), undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
