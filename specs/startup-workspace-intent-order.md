# 启动恢复与显式打开工作区的顺序

Main 是未就绪窗口 `--open-workspace`/deep-link 请求的唯一暂存所有者。Renderer 的 Root/TabStore 继续拥有窗口导航；沿原 `handleSelectProject` 打开路径，不添加平行队列或新的业务状态所有者。

Renderer 必须安装平台事件监听器，并完成初始工作区恢复/注入，才通知 Main `notifyRendererReady()`。否则 Main 过早释放显式目录，之后默认 initial workspace 的注入会再次激活默认目录，导致指定目录进入最近项目但实际运行 cwd 错误。

```mermaid
sequenceDiagram
  participant Main
  participant Root
  participant Tabs as TabStore
  Main->>Main: 暂存显式打开目录请求
  Root->>Root: 安装平台事件监听器
  Root->>Tabs: 恢复历史并注入初始工作区
  Root->>Main: notifyRendererReady
  Main->>Root: 原 onOpenWorkspacePath
  Root->>Tabs: 原 handleSelectProject 添加并激活指定目录
```

约束：恢复未完成时不发送 ready；恢复完成后原默认入口仍可用，显式目录最终激活且历史 tab 保留。StrictMode 清理或卸载后的旧 microtask 不发通知，Main 的原一次性消费保证不重复打开。恢复后的常规打开目录行为不变。Web/远端路径沿既有 ready 能力，不按延时猜测就绪。

验收需包括真实 React hook 的 held-restore、恢复后显式目录胜出、StrictMode、卸载和正常路径；最终在真实打包应用中，从启动期间原 secondary 命令进入指定目录，完成首次引导后核对实际模型 cwd。单纯 recentProjects 或 secondary exit 0 不算完成。

在客户端根目录使用固定 Node 24 运行：

```sh
pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/startupWorkspaceReady.test.mjs
node --test packages/desktop/test/rendererReadyWorkspace.integration.mjs
pnpm exec tsx --test packages/desktop/test/startupFallbackCwd.test.ts
node --test packages/desktop/test/startupFallbackCwd.integration.mjs
```

## Renderer reload 与旧窗口入口

窗口 URL 的 `initialWorkspacePath`/`initialTaskId` 是该窗口创建时的入口，后续用户切换项目不会改写 URL。Renderer reload 必须由原 TabStore 的持久恢复选择拥有当前导航；已有恢复 active workspace 时，不再次注入旧 initial path 或重放旧 taskId。否则保存的项目 index0 先恢复成功，又被旧 default conversation 入口激活为 index1。

该判断只在既有 `canBootstrapInitialWorkspace` 门禁释放后读取本次原恢复状态，不新增缓存、队列或定时器。reload 没有可用恢复 active workspace 时，继续原 initial workspace fallback；普通冷启动继续按原显式入口覆盖历史选择。Main 在 ready 后交付的新 secondary/deep-link 属于新用户意图，仍沿原事件处理器激活指定目录，不被 reload 规则阻止。

顺序：原 persisted tabs/active 恢复 → Root 判定 reload 是否已有有效 active workspace → 保留恢复选择或执行原 fallback → 通知 Main ready → 消费本次新显式请求。永久回归使用真实 React Hook/TabStore，覆盖 reload 保留项目、无历史 fallback、冷启动入口及新 secondary 请求；真实 Mac 原包再验证文件预览前后 reload、模型 cwd 与独立账本。
