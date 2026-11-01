import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runServerCli } from "./cli.js";
import { resolveBundledAgentWiring } from "./runtime/agentWiring.js";
import { createUpdateDaemonHandoff } from "./runtime/updateHandoff.js";

// 自动接线只作为本次 CLI 的显式依赖传入，不能污染全局 env；candidate release 启动时
// Supervisor 会按 candidate runtime 重新计算，避免继承旧 release 的 zcode.cjs。
const bundledAgentWiring = await resolveBundledAgentWiring(
  dirname(fileURLToPath(import.meta.url)),
  process.env,
);

void runServerCli(
  process.argv.slice(2),
  {
    stdout: process.stdout,
    stderr: process.stderr,
    confirm: async (prompt) => {
      process.stdout.write(prompt);
      return await new Promise<string>((resolve) => {
        process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
      });
    },
  },
  {
    bundledAgentWiring,
    updateDaemonHandoff: createUpdateDaemonHandoff(),
  },
).then((exitCode) => {
  process.exitCode = exitCode;
  // once("data") 完成确认后仍让 stdin 保持 flowing，终端未关闭时卸载/取消会挂起。
  // 仅在原命令终态暂停输入，让进程自然退出，不强制截断其他待完成 IO。
  process.stdin.pause();
});
