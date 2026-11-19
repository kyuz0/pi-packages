import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

test("container copy reads a literal mounted source and keeps other checks", async (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const modules = join(root, "node_modules");
  // Stage the installed release under node_modules so its transitive dependencies
  // still resolve. This exercises the same patch the image build applies.
  const fixture = mkdtempSync(join(modules, ".container-copy-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const scoped = join(fixture, "node_modules", "@gotgenes");
  mkdirSync(scoped, { recursive: true });
  const pkg = join(scoped, "pi-permission-system");
  cpSync(join(modules, "@gotgenes/pi-permission-system"), pkg, { recursive: true });
  execFileSync("git", ["apply", "--directory", fixture.slice(root.length),
    join(root, "scripts/permission-system-copy.patch")], { cwd: root });
  const jiti = createJiti(import.meta.url, { tryNative: false });
  const load = (path) => jiti.import(join(pkg, "src", path + ".ts"));
  const { BashProgram } = await load("access-intent/bash/program");
  const { posixPathFlavor } = await load("path/path-flavor");
  const { PathNormalizer } = await load("path/path-normalizer");
  const normalizer = new PathNormalizer(posixPathFlavor, "/workspace/app");
  const src = "/mnt/reference/nested/readme.txt";
  const dst = "/mnt/output/nested/copied.txt";

  for (const command of [`cp ${src} ${dst}`, `cp -- '${src}' "${dst}"`]) {
    const program = await BashProgram.parse(command, normalizer);
    assert.deepEqual(program.externalAccesses().map(({ path, effect }) =>
      [path.value(), effect.effect]), [[src, "read"], [dst, "unproven"]], command);
    // Credential and other path-level denials still consult both directions.
    assert(program.pathRuleCandidates().every(({ effect }) => effect.effect === "unproven"));
  }

  for (const command of [
    `cp ${src} ${src}`, `cp -r ${src} ${dst}`, `cp -t ${dst} ${src}`,
    `cp --target-directory=${dst} ${src}`, `env cp ${src} ${dst}`,
    `/usr/bin/cp ${src} ${dst}`, `OPT=1 cp ${src} ${dst}`,
    `cp ${src} "$target"`, `cp ${src} /mnt/output/*`, `cp ${src} ''`,
    `cp ${src} /tmp/other ${dst}`, `cp /mnt/reference/../../opt/file ${dst}`,
    `cp /opt/file ${dst}`, `cp /mnt/reference-other/../reference/a ${dst}`,
    `bash -c 'cp ${src} ${dst}'`,
  ]) {
    const program = await BashProgram.parse(command, normalizer);
    assert(program.externalAccesses().every(({ effect }) => effect.effect !== "read"), command);
  }

  const nested = await BashProgram.parse(`cp ${src} "$(cat /tmp/list)" > /tmp/log`, normalizer);
  assert.deepEqual(nested.externalAccesses().map(({ path, effect }) =>
    [path.value(), effect.effect]), [[src, "unproven"], ["/tmp/list", "read"], ["/tmp/log", "write"]]);
});
