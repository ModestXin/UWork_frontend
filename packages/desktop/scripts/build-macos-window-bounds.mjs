#!/usr/bin/env node
// 编译 macOS 窗口 bounds 辅助程序（CUA 权限浮窗的吸附数据源）。
//
// 非 darwin 直接跳过：这个二进制只服务 macOS 的 TCC 授权引导，其他平台没有对应流程。
// 缺少 swiftc（未装 Xcode CLT）时也只警告不失败 —— 吸附是观感增强，拿不到 bounds 时浮窗
// 会 fail-open 到屏幕底部照样可用，不该因此让整个 desktop 构建挂掉。

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTargetPlatform } from "./target-platform.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "macos-window-bounds", "main.swift");
const outputDir = join(packageRoot, "resources", "macos-window-bounds");
const outputPath = join(outputDir, "zcode-window-bounds");
const target = getTargetPlatform();
const targetOutputPath = `${outputPath}-${target.arch}`;
const discardTargetOutput = () => {
  rmSync(targetOutputPath, { force: true });
  if (target.arch === process.arch) rmSync(outputPath, { force: true });
};

if (process.platform !== "darwin" || target.os !== "darwin") {
  console.log("[window-bounds] 跳过：仅 macOS 需要");
  process.exit(0);
}

if (!existsSync(sourcePath)) {
  console.error(`[window-bounds] 源文件缺失：${sourcePath}`);
  process.exit(1);
}

function hasSwiftc() {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasSwiftc()) {
  discardTargetOutput();
  console.warn("[window-bounds] 未找到 swiftc（需 Xcode Command Line Tools）；跳过构建。");
  console.warn("[window-bounds] 权限浮窗仍可用，但不会吸附到系统设置窗口。");
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });
const stagedPath = `${outputPath}-${target.arch}-${process.pid}`;
const hostStagedPath = `${outputPath}-${process.pid}`;

try {
  // 发布链按架构分别出包；仅编译目标，避免另一架构的 Swift 支持库缺失让本机产物也丢失。
  const swiftArch = target.arch === "arm64" ? "arm64" : "x86_64";
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", `${swiftArch}-apple-macos11`, sourcePath, "-o", stagedPath],
    { stdio: "inherit" },
  );
  renameSync(stagedPath, targetOutputPath);
  // 包始终使用架构独立源文件；只有本机架构更新开发态固定路径，避免跨架构构建互相覆盖。
  if (target.arch === process.arch) {
    copyFileSync(targetOutputPath, hostStagedPath);
    renameSync(hostStagedPath, outputPath);
  }
  console.log(`[window-bounds] 已构建 ${target.arch} 二进制：${targetOutputPath}`);
} catch (error) {
  // 目标切换后旧输出可能属于另一架构，失败时不能将它误带入新包。
  discardTargetOutput();
  console.warn(
    "[window-bounds] 构建失败；权限浮窗仍可用但不会吸附：",
    error instanceof Error ? error.message : String(error),
  );
} finally {
  rmSync(stagedPath, { force: true });
  rmSync(hostStagedPath, { force: true });
}
