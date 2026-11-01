import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

test("normal Server build embeds the same app version as release staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-server-version-"));
  try {
    const packageJson = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    const source = fileURLToPath(new URL("../../shared/src/version.ts", import.meta.url));
    const entry = join(root, "entry.ts");
    await writeFile(
      entry,
      `import {ZCODE_VERSION} from ${JSON.stringify(source)};\nprocess.stdout.write(ZCODE_VERSION);\n`,
    );
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    const [{ default: config }, { build }] = await Promise.all([
      import("../tsup.config.ts"),
      import("tsup"),
    ]);
    const outDir = join(root, "out");
    await build({ ...config, config: false, entry: { version: entry }, outDir, silent: true });
    const bundle = (await readdir(outDir)).find((name) => /\.(?:mjs|js)$/.test(name));
    assert.ok(bundle);
    const { stdout } = await promisify(execFile)(process.execPath, [join(outDir, bundle)], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, NODE_ENV: "production" },
      timeout: 5000,
    });
    assert.equal(
      stdout,
      packageJson.version,
      "Core ready.version must match stageCli manifest.appVersion",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
