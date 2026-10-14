import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "./policy.ts";

/** Give a managed worker its own config without exposing the parent's home. */
export function prepareContainerWorker(env: NodeJS.ProcessEnv, policy: SandboxPolicy) {
  if (env.PI_SANDBOX_CONTAINER !== "1") return undefined;
  const source = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const directory = mkdtempSync(join(tmpdir(), "pi-worker-config-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    for (const name of ["models.json", "auth.json", "APPEND_SYSTEM.md"]) {
      try { copyFileSync(join(source, name), join(directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(readFileSync(join(source, "settings.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // The whole worker is already OS-isolated by its parent. Keep review inside
    // it, without loading another sandbox, escalation tool or arbitrary packages.
    settings.packages = [];
    settings.extensions = [
      "/opt/pi-security/packages/pi-auto-review/src/index.ts",
      "/opt/pi-security/node_modules/@gotgenes/pi-permission-system/src/index.ts",
    ];
    writeFileSync(join(directory, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
    return {
      env: { ...env, PI_CODING_AGENT_DIR: directory },
      policy: { ...policy, filesystem: { ...policy.filesystem,
        allowRead: [...policy.filesystem.allowRead, directory],
        allowWrite: [...policy.filesystem.allowWrite, directory],
      } },
      directory, cleanup,
    };
  } catch (error) { cleanup(); throw error; }
}
