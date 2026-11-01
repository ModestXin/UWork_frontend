import { resolveServerLayout } from "../runtime/paths.js";
import { createServerCoreProfileEnvironment } from "../runtime/serverCoreProfileEnvironment.js";

// 旧 Supervisor 也能启动新 Core；必须先绑定 profile 再加载会捕获环境的服务模块。
Object.assign(
  process.env,
  createServerCoreProfileEnvironment(resolveServerLayout(process.env.ZCODE_SERVER_ROOT)),
);

const generation = Number(process.argv[2] ?? 0);
void import("./core.js")
  .then(({ runServerCore }) => runServerCore(generation))
  .catch((error: unknown) => {
    // 与 core.ts 的 shutdown 路径同理——启动失败往往发生在服务已部分初始化
    // 之后（SQLite、interval 等仍持有事件循环 handle），仅设置 exitCode 会让进程
    // 挂着不退出；Supervisor 收不到 exit 事件就不会走崩溃退避，状态永久卡在 starting。
    // fatal 消息发出（或无 IPC 通道）后必须显式退出。
    const exit = (): void => process.exit(1);
    if (typeof process.send !== "function" || process.connected === false) {
      exit();
      return;
    }
    try {
      process.send(
        { type: "fatal", message: error instanceof Error ? error.message : String(error) },
        exit,
      );
    } catch {
      // 父进程可能在启动失败的同时断开 IPC，不能等待一个永远不会到达的 fatal callback。
      exit();
    }
  });
