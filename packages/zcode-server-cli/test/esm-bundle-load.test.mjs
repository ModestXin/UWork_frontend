import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test(
  "the production tsup config emits Node ESM that loads relative CommonJS builtins",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "server-cli-esm-load-"));
    await chmod(directory, 0o700);
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
    await writeFile(
      join(directory, "reader.cjs"),
      `const fs = require("node:fs");
module.exports = {
  readWorked: fs.readFileSync(__filename, "utf8").includes("SERVER_CLI_ESM_PROBE"),
  dirnameWorked: fs.statSync(__dirname).isDirectory(),
};
`,
      { mode: 0o600 },
    );
    const entry = join(directory, "entry.ts");
    await writeFile(
      entry,
      'import value from "./reader.cjs"; process.stdout.write(JSON.stringify(value));\n',
      { mode: 0o600 },
    );
    const output = join(directory, "output");
    await mkdir(output, { mode: 0o700 });
    const [{ default: configuration }, { build }] = await Promise.all([
      import("../tsup.config.ts"),
      import("tsup"),
    ]);
    assert.ok(configuration && typeof configuration === "object" && !Array.isArray(configuration));
    await build({
      ...configuration,
      config: false,
      entry: { probe: entry },
      outDir: output,
      silent: true,
    });
    const bundles = (await readdir(output)).filter((name) => /\.(?:mjs|js)$/.test(name));
    assert.equal(bundles.length, 1);
    let result;
    try {
      const { stdout, stderr } = await execute(process.execPath, [join(output, bundles[0])], {
        cwd: directory,
        env: process.env,
        timeout: 5000,
        maxBuffer: 16384,
      });
      result = { code: 0, signal: null, stdout, stderr };
    } catch (error) {
      result = {
        code: error.code,
        signal: error.signal,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
    const dynamicFsRejected = /Dynamic require of ["'](?:node:)?fs["'] is not supported/.test(
      result.stderr,
    );
    assert.equal(
      result.code,
      0,
      `generated ESM must execute; dynamic builtin require rejected=${dynamicFsRejected}`,
    );
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { readWorked: true, dirnameWorked: true });
  },
);
