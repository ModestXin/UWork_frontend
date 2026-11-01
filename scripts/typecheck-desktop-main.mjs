import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const compiler = require.resolve("typescript/bin/tsc");
// tsup 会清空 server/dist，但旧 tsbuildinfo 仍可能说 up-to-date。
// 明确重建引用声明后严格检查 Main，不关闭检查，也不向运行目录发射 Main JS。
for (const args of [
  ["-b", "packages/server", "--force", "--emitDeclarationOnly"],
  ["-p", "packages/desktop/tsconfig.main.json", "--noEmit"],
]) {
  const result = spawnSync(process.execPath, [compiler, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
