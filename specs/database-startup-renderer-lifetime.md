# 数据库启动状态中继与渲染帧生命周期

`databaseStartupRelay` 只拥有 Host 启动状态的单向镜像，Host 仍是数据库迁移与 ready 状态所有者。BrowserWindow 与 WebContents 尚未销毁，不代表主渲染帧仍可接收 IPC：关闭、reload 或渲染进程退出时，帧可能先 detached/destroyed。

原 Host 状态仍须按 startupId 和 sequence 接受并保留；向已经 detached/destroyed 的主帧不得发送。主帧重新可达时，原 snapshot 控制应收到最新状态，包括 Host 已退出的 `failed/transport_closed`，不能回放旧 ready。新 Host 绑定、窗口销毁和原控制鉴权不变。不得通过取消 Host 退出事件或抹掉失败状态来压制日志。

回归：有效帧得到 ready；仅帧销毁而窗口仍活时 Host exit 不发送；换上有效帧后 snapshot 得到最新失败；旧 Host 状态、旧绑定和不同 sender 被拒；窗口 closed 释放原监听。测试真实模块与边界替身，另以未打包真实 UI 运行/关闭日志验证无该异常。

API 根据当前 Electron 类型声明与 [WebFrameMain 官方文档](https://www.electronjs.org/docs/latest/api/web-frame-main/) 的 `isDestroyed()`、`detached` 验证。
