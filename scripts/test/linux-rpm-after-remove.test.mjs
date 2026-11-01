import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  readlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { desktopProductIdentities } from "../../packages/desktop/scripts/desktop-product-identity.mjs";

const require = createRequire(import.meta.url);
const { default: FpmTarget } = require("app-builder-lib/out/targets/FpmTarget.js");
const { default: config } = await import("../../packages/desktop/electron-builder.config.js");
const desktopRoot = fileURLToPath(new URL("../../packages/desktop", import.meta.url));
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

async function fixture(identity, run) {
  const root = await mkdtemp(join(tmpdir(), "uwork-rpm-remove-"));
  const install = join(root, "opt", identity.productName);
  const bin = join(root, "bin");
  const receipt = join(root, "alternatives-receipt.txt");
  const profile = join(root, "apparmor", identity.linuxExecutableName);
  try {
    await Promise.all([
      mkdir(bin),
      mkdir(join(install, "nested/empty"), { recursive: true }),
      mkdir(join(root, "apparmor")),
    ]);
    await writeFile(profile, "owned AppArmor fixture");
    const alternative = join(bin, "update-alternatives");
    await writeFile(
      alternative,
      `#!/bin/sh
if [ "$ALTERNATIVES_FAILURE" = "$1" ]; then
  echo "permission denied by controlled tool fixture" >&2
  exit 73
fi
case "$1" in
  --list) [ "$ALTERNATIVES_STATE" = absent ] || printf '%s auto %s\\n' "$ALTERNATIVES_NAME" "$ALTERNATIVES_TARGET"; exit 0 ;;
  --display) printf '%s - priority 100\\n' "$ALTERNATIVES_TARGET"; exit 0 ;;
  --remove)
    if [ "$ALTERNATIVES_STATE" = absent ] || [ "$ALTERNATIVES_STATE" = foreign ]; then exit 2; fi
    printf '%s\\n' "$@" > "$ALTERNATIVES_RECEIPT" ;;
esac
`,
    );
    await chmod(alternative, 0o700);
    let sequence = 0;
    const scripts = await FpmTarget.prototype.createScripts.call({
      options: { ...config.linux, ...config.rpm },
      packager: {
        executableName: identity.linuxExecutableName,
        appInfo: {
          sanitizedProductName: identity.productName,
          productFilename: identity.productName,
        },
        platformSpecificBuildOptions: config.linux,
        projectDir: desktopRoot,
        info: {
          tempDirManager: {
            async getTempFile({ suffix }) {
              return join(root, `${++sequence}-${suffix}`);
            },
          },
        },
      },
    });
    const original = await readFile(scripts.afterRemove, "utf8");
    // 单位测试显式映射目录，防止 shell 触碰本机真实安装路径；真实 RPM 事务另测原脚本。
    const mapped = original
      .replaceAll("/opt/", root + "/opt/")
      .replaceAll("/usr/bin/", root + "/usr-bin/")
      .replaceAll("/etc/apparmor.d/", root + "/apparmor/");
    const script = join(root, "mapped-after-remove.sh");
    await writeFile(script, mapped);
    const execute = (remaining, overrides = {}) =>
      promisify(execFile)("/bin/bash", [script, String(remaining)], {
        env: {
          PATH: bin + ":/usr/bin:/bin",
          ALTERNATIVES_RECEIPT: receipt,
          ALTERNATIVES_NAME: identity.linuxExecutableName,
          ALTERNATIVES_TARGET: join(install, identity.linuxExecutableName),
          ...overrides,
        },
        timeout: 5000,
      });
    await run({ root, install, receipt, profile, execute, alternative, bin });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const identity of Object.values(desktopProductIdentities)) {
  test(`normal RPM ${identity.flavor} final hook unregisters installed target and empty tree`, async () => {
    await fixture(identity, async ({ root, install, receipt, profile, execute }) => {
      const sibling = join(root, "opt", "other-product");
      await mkdir(sibling);
      await writeFile(join(sibling, "preserve.txt"), "other package");
      await execute(0);
      assert.deepEqual((await readFile(receipt, "utf8")).trim().split("\n"), [
        "--remove",
        identity.linuxExecutableName,
        join(install, identity.linuxExecutableName),
      ]);
      assert.equal(await exists(install), false);
      assert.equal(await exists(profile), false);
      assert.equal(await readFile(join(sibling, "preserve.txt"), "utf8"), "other package");
    });
  });
}

test("RPM upgrade preserves the new alternative, installation and AppArmor", async () => {
  await fixture(
    desktopProductIdentities.preview,
    async ({ install, receipt, profile, execute }) => {
      await execute(1);
      assert.equal(await exists(receipt), false);
      assert.equal(await exists(join(install, "nested/empty")), true);
      assert.equal(await exists(profile), true);
    },
  );
});

test("final RPM removal retains nonempty custom content and removes empty branches", async () => {
  await fixture(desktopProductIdentities.preview, async ({ install, execute }) => {
    await writeFile(join(install, "custom-preserve.txt"), "user-added fixture content");
    await execute(0);
    assert.equal(
      await readFile(join(install, "custom-preserve.txt"), "utf8"),
      "user-added fixture content",
    );
    assert.equal(await exists(join(install, "nested")), false);
  });
});

test("missing alternatives registration still cleans this app's AppArmor and empty tree", async () => {
  await fixture(
    desktopProductIdentities.preview,
    async ({ install, receipt, profile, execute }) => {
      await execute(0, { ALTERNATIVES_STATE: "absent" });
      assert.equal(await exists(receipt), false);
      assert.equal(await exists(install), false);
      assert.equal(await exists(profile), false);
    },
  );
});

test("real alternatives command failures remain visible", async () => {
  for (const failingCommand of ["--list", "--display", "--remove"]) {
    await fixture(desktopProductIdentities.preview, async ({ profile, execute }) => {
      await assert.rejects(execute(0, { ALTERNATIVES_FAILURE: failingCommand }), (error) => {
        assert.equal(error.code, 73);
        assert.match(error.stderr, /permission denied by controlled tool fixture/);
        return true;
      });
      assert.equal(await exists(profile), true);
    });
  }
});

test("RPM cleanup never follows the installation root symlink", async () => {
  await fixture(desktopProductIdentities.preview, async ({ root, install, execute }) => {
    const outside = join(root, "outside-root");
    await mkdir(join(outside, "empty"), { recursive: true });
    await rm(install, { recursive: true });
    await symlink(outside, install);
    await execute(0);
    assert.equal(await readlink(install), outside);
    assert.equal(await exists(join(outside, "empty")), true);
  });
});

test("RPM cleanup never follows an internal symlink to an external empty tree", async () => {
  await fixture(desktopProductIdentities.preview, async ({ root, install, execute }) => {
    const outside = join(root, "outside-child");
    await mkdir(join(outside, "empty"), { recursive: true });
    await symlink(outside, join(install, "external-link"));
    await execute(0);
    assert.equal(await readlink(join(install, "external-link")), outside);
    assert.equal(await exists(join(outside, "empty")), true);
    assert.equal(await exists(join(install, "nested")), false);
  });
});

test("an absent owned target leaves another alternative intact and completes owned cleanup", async () => {
  await fixture(
    desktopProductIdentities.preview,
    async ({ root, install, receipt, profile, execute }) => {
      await execute(0, {
        ALTERNATIVES_STATE: "foreign",
        ALTERNATIVES_TARGET: join(root, "other-program"),
      });
      assert.equal(await exists(receipt), false);
      assert.equal(await exists(install), false);
      assert.equal(await exists(profile), false);
    },
  );
});

for (const owned of [true, false]) {
  test(`without alternatives, direct launcher ownership ${owned} controls unlink`, async () => {
    await fixture(
      desktopProductIdentities.preview,
      async ({ root, install, alternative, bin, execute }) => {
        await rm(alternative);
        for (const [name, target] of [
          ["find", "/usr/bin/find"],
          ["readlink", "/usr/bin/readlink"],
          ["rm", "/bin/rm"],
        ])
          await symlink(target, join(bin, name));
        await mkdir(join(root, "usr-bin"));
        const target = owned ? join(install, "zcode-preview") : join(root, "foreign-program");
        const link = join(root, "usr-bin/zcode-preview");
        await symlink(target, link);
        await execute(0, { PATH: bin });
        if (owned) await assert.rejects(readlink(link), { code: "ENOENT" });
        else assert.equal(await readlink(link), target);
      },
    );
  });
}
