# Server CLI 的 ESM 启动

状态：2026-10-19。修复正常 server-cli 构建在进入原命令前因 bundled CommonJS 的 Node builtin require 失败而退出；不新增命令、权限或运行时服务。

## 所有者与不变量

- `packages/zcode-server-cli/tsup.config.ts` 唯一拥有 CLI/Core 两个 Node ESM bundle 的启动兼容 banner。两入口沿原 `import.meta.url` 定位同目录组件。
- 原 CommonJS 依赖保留正常 Node builtin require 语义。banner 在 bundled 模块执行前建立词法 `require = createRequire(import.meta.url)`，不写入全局，不引入另一加载器或更换依赖。
- 原 `__filename`、`__dirname` 继续对应当前 ESM 输出文件及其目录。ESM format、target、external/noExternal、嵌入配置与原 lifecycle/authority 合同保持。
- 模块解析成功不等于模块执行成功；不得以 `require.resolve` 或静态 banner 字符串断言替代真实 ESM 加载。

## 验收

1. 测试动态读取实际 tsup 配置并调用真实 tsup build；只将 entry/outDir 指向独占临时 fixture，不生成或覆盖正常 CLI/Core/dist-release/Desktop 产物。
2. 相对 CommonJS fixture 实际调用 `require('node:fs')`，用 `__filename` 读取本次生成的 bundle，并以 `__dirname` 验证当前输出目录。
3. 原 Node 子进程执行生成的 ESM。旧配置先真实 exit1；修复后 exit0、stderr为空、JSON 中读取和目录检查均为 true。
4. 测试 imports 前使用隔离 HOME/TMP 与明确 production 环境，保留已审 env-file guard；不读取私人环境文件，不安装或下载依赖，不启动 Server/Agent、OS 注册或模型。
5. 必须等子进程实际终态后才清理本次测试临时目录。既有 W03 原失败、诊断与 retained root 不参与此测试。

定向入口：`node --import tsx --test packages/zcode-server-cli/test/esm-bundle-load.test.mjs`。本机执行需使用 `mise.toml` 的 Node24 与已审 envguard；本次证据另行记录完整 allowlist，不在永久测试中钉住机器路径。

此回归证明实际配置生成的 ESM 可以加载该相对 CJS/builtin 路径；不替代新正常产物、完整 server-cli lifecycle、发行包 Node22、跨平台或安装验收。
