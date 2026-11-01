import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolveNodePtyNativePath(nativePackageRoot, platformKey) {
  const candidates = [
    resolve(nativePackageRoot, "pty.node"),
    resolve(nativePackageRoot, "prebuilds", platformKey, "pty.node"),
  ].filter((path) => existsSync(path));
  if (candidates.length !== 1 || !statSync(candidates[0]).isFile()) {
    throw new Error(`node-pty native 缺失或布局有歧义: ${nativePackageRoot} (${platformKey})`);
  }
  return candidates[0];
}

function validateHeader(path, os, arch, platformKey) {
  const header = readFileSync(path).subarray(0, 20);
  const machine = { arm64: 183, x64: 62 }[arch];
  const valid =
    os === "linux"
      ? header.length === 20 &&
        header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
        header[4] === 2 &&
        header[5] === 1 &&
        header.readUInt16LE(18) === machine
      : header.length >= 8 &&
        header.readUInt32LE(0) === 0xfeedfacf &&
        header.readUInt32LE(4) === { arm64: 0x100000c, x64: 0x1000007 }[arch];
  if (!machine || !valid)
    throw new Error(
      `node-pty native ${os === "linux" ? "ELF" : "Mach-O"} 架构不匹配: ${platformKey}`,
    );
}

/** 构建期只读组合验证；不复制、不认可旧目标缓存，也不执行跨平台 native。 */
export function resolveNodePtyPrebuildAssets({ jsPackageRoot, nativePackageRoot, platformKey }) {
  const match = /^(linux|darwin)-(arm64|x64)$/.exec(platformKey);
  if (!match) throw new Error(`不支持 node-pty 平台: ${platformKey}`);
  const [, os, arch] = match;
  const readPackage = (root) => JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const js = readPackage(jsPackageRoot);
  const native = readPackage(nativePackageRoot);
  const expectedName = `@lydell/node-pty-${platformKey}`;
  // 1.1 JS 传三参、Beta native 要五参；相同文件名和可加载均不能代替版本/平台合同。
  if (
    js.name !== "node-pty" ||
    native.name !== expectedName ||
    typeof js.version !== "string" ||
    !js.version.trim() ||
    typeof native.version !== "string" ||
    js.version !== native.version ||
    !Array.isArray(native.os) ||
    !native.os.includes(os) ||
    !Array.isArray(native.cpu) ||
    !native.cpu.includes(arch)
  ) {
    throw new Error(
      `node-pty JS/native 版本或平台不一致: JS ${js.version}, ${expectedName} ${native.version} (${platformKey})`,
    );
  }
  const nativePath = resolveNodePtyNativePath(nativePackageRoot, platformKey);
  validateHeader(nativePath, os, arch, platformKey);
  let spawnHelperPath;
  if (os === "darwin") {
    spawnHelperPath = resolve(dirname(nativePath), "spawn-helper");
    if (!existsSync(spawnHelperPath) || !statSync(spawnHelperPath).isFile())
      throw new Error(`Darwin node-pty 缺少同布局 spawn-helper: ${platformKey}`);
    validateHeader(spawnHelperPath, os, arch, platformKey);
  }
  return Object.freeze({ version: js.version, platformKey, nativePath, spawnHelperPath });
}
