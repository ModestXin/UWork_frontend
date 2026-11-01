import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import {
  resolveNodePtyNativePath,
  resolveNodePtyPrebuildAssets,
} from "../../../scripts/node-pty-prebuild-assets.mjs";

const require = createRequire(import.meta.url);

export function restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }) {
  if (targetPlatform.os !== "linux") {
    console.log(`[beforePack] node-pty prebuild restore skipped for ${targetPlatform.key}`);
    return;
  }

  const platformKey = targetPlatform.key;
  const sourcePackageName = `@lydell/node-pty-${platformKey}`;
  let sourcePackageRoot;

  try {
    sourcePackageRoot = resolveSourcePackageRoot({ sourcePackageName, desktopPackageRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`缺少 ${sourcePackageName}，无法为 ${platformKey} 打包 node-pty: ${message}`);
  }

  const nodePtyPackageRoot = dirname(
    require.resolve("node-pty/package.json", { paths: [desktopPackageRoot] }),
  );
  const { nativePath: sourceBinaryPath } = resolveNodePtyPrebuildAssets({
    jsPackageRoot: nodePtyPackageRoot,
    nativePackageRoot: sourcePackageRoot,
    platformKey,
  });
  const targetPrebuildDir = resolve(nodePtyPackageRoot, "prebuilds", platformKey);
  const targetBinaryPath = resolve(targetPrebuildDir, "pty.node");

  // Linux 包中 node-pty 本体只会查自己的 prebuilds/linux-*/pty.node，
  // 但 Linux 预编译文件实际来自 @lydell/node-pty-linux-* 平台包；若排除该平台包，
  // 而 node-pty 自身目录没有 linux prebuild，最终安装包里会缺 pty.node，终端启动失败。
  // 这里在 beforePack 阶段恢复依赖资产，让后续 asarUnpack 按标准链路处理 native addon。
  mkdirSync(targetPrebuildDir, { recursive: true });
  cpSync(sourceBinaryPath, targetBinaryPath);

  if (!existsSync(targetBinaryPath))
    throw new Error(`node-pty 预编译产物恢复失败: ${targetBinaryPath}`);

  console.log(`[beforePack] node-pty prebuild restored: ${targetBinaryPath}`);
}

export function resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey }) {
  return resolveNodePtyNativePath(resolveSourcePackageRoot({ sourcePackageName }), platformKey);
}

function resolveSourcePackageRoot({ sourcePackageName, desktopPackageRoot }) {
  const options = desktopPackageRoot ? { paths: [desktopPackageRoot] } : undefined;
  try {
    // 原 1.1 平台包只有 package.json/pty.node，没有可解析的 JS 入口。
    return dirname(require.resolve(`${sourcePackageName}/package.json`, options));
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  const sourcePackageEntry = require.resolve(sourcePackageName, options);
  let currentDir = dirname(sourcePackageEntry);
  while (currentDir !== dirname(currentDir)) {
    if (existsSync(resolve(currentDir, "package.json"))) return currentDir;
    currentDir = dirname(currentDir);
  }
  throw new Error(`无法定位 node-pty 平台包: ${sourcePackageName}`);
}

export function resolvePackagedNodePtyPrebuildPath({ resourcesDir, platformKey }) {
  return resolve(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    platformKey,
    "pty.node",
  );
}
