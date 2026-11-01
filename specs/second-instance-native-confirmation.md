# 第二实例与外部工作区确认

Linux 实际 AppImage 的系统 xdg-open 投递到现有进程后，第二进程连接 SingletonSocket 成功，却在约 20 秒后向原 Electron 发出 SIGKILL；AppImage 父 runtime 随后返回 127。带完整窗口管理器及进程/信号追踪也复现。不能通过延长测试超时、移除用户确认或跳过单实例锁消除失败。

Chromium 只有在 notification callback 返回后才写回 ACK；Electron ready 后同步发出 second-instance。Main 原事件处理直接进入同步原生确认，会占住该返回边界。Main 继续是唯一协议 owner，但事件入口必须只安排后续处理并立即返回；实际 URL/路径校验、外部确认、已有 pending workspace 和 renderer ready gate 继续复用原处理函数。

```mermaid
sequenceDiagram
  participant S as 系统协议第二进程
  participant E as Electron 单实例入口
  participant M as Main 后续事件循环
  participant U as 异步原生确认与现有工作区入口
  S->>E: argv / additionalData
  E->>M: setImmediate 安排一次原处理
  E-->>S: 原通知返回并 ACK
  M->>U: 原 URL 校验与确认
  U-->>M: 取消保持原目录，确认后才发原 IPC
```

使用 setImmediate 是事件循环交接，不能替换为任意毫秒延迟。每个事件独立捕获 argv，FIFO 处理，不合并/重放、不引入第二份任务状态。未识别请求的原窗口恢复/聚焦也在后续处理。已有 additionalData 优先级、UNC/非法路径拒绝、取消和 locale 文案不变。

验收：纯事件顺序/回退/两事件隔离测试；正常客户端构建和原配置打包；系统真实 URI 取消与确认。原确认停留至少 25 秒时第二进程应已正常退出、原实例和窗口存活，取消不切换，确认才切换，模型/账本无增量。追踪用于定位，最终还要无追踪器复测。macOS/Windows 同步原入口保持相同后续处理语义，平台原生验收分列。

确认停留期间再从系统投递一个未知的自有 zcode URI，核对它也能完成握手退出，且仅保留原 Electron Main；不能只证明第一个请求不再误杀，而让随后请求仍因确认未决而卡住。

未持锁的第二实例按[拒锁副实例退出规则](desktop-secondary-process-exit.md)直接结束，不创建首窗login-shell预热，不得进入 app.whenReady 的应用 bootstrap；普通主实例继续沿已有退出确认与屏障收口。早期修复运行中观测到多个 Main 和额外窗口；单独的进程快照不能证明每个进程均已获得锁。即使拒锁后的退出边界意外返回或ready已排队，原false guard也不能启动新的窗口、Host或Agent。

提取运行模式还必须独立验证实际发行 runtime 的并发文件生命周期：第二 runtime 退出时原实例的文件仍应存在，原 owner 退出后再核对清理。实际包已否定“第二次运行必然删掉共享目录”的假设，因此不改 .desktop 环境前缀或加入 NO_CLEANUP；上游源码推测不能替代当前产物证据。

依据：[Electron 41.10.7 通知封装](https://github.com/electron/electron/blob/v41.10.7/shell/browser/api/electron_api_app.cc) 与 [Chromium Singleton ACK 顺序](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/process_singleton_posix.cc)，以及本仓库 `client-linux-desktop-appimage-wmtrace-v8-20261020` 的真实连接/kill/终态记录。产品重建复测仍负责证明该修复适用于当前发行运行时。

## 确认未决时继续接收系统协议

v13 实测区分了两个问题：首次通知 ACK 正常、原 Main 存活，但 8 秒后发送的并行 URI 对应 Electron 仍在等待握手。25 秒采样时该并行进程仅等待约 17 秒，不能据此断言它已拿锁或越过 ready 门禁。同步 GTK 确认仍阻塞 Main 接收后续通知，单次 setImmediate 不足以覆盖确认未决期间的新请求。

Main 的外部工作区确认统一使用 Electron 异步 showMessageBox。desktopOAuthDeepLink 是确认顺序的唯一 owner，以单条 Promise 尾链串行展示确认，不存储第二份已接受任务；每个原生通知仍立即返回 consumed 布尔值，确认成功后才走原 handleOpenWorkspacePath。无效 URL/UNC 仍在任何文件系统探测前拒绝。冷启动 bootstrap 必须 await 同一确认入口，取消仍回退原默认启动。

每个请求绑定发起时业务窗口；队列等待、确认返回时均复核窗口未销毁和 Main 未进入退出屏障。失效、取消或对话框失败均不投递，不转交其他窗口，不触发兜底目录打开；异常记录并使后续请求继续。未知 URI 不等待确认队列。新增受控原代码测试必须先 RED，再证明未决期间返回、两个确认串行、取消/同意、窗口销毁、退出失效、异常后队列恢复和冷启动等待。

平台限制：Electron 41 的 macOS 无父窗口 showMessageBox 仍可能同步执行；本轮 Linux 运行中确认结果不能外推 macOS 冷启动确认已完成原生验收。

## additionalData 的版本化 ASCII 传输

macOS 原 Electron41.10.7 在 `--open-workspace` 中文空格路径的真实第二入口记录 `additional_data_size exceeds payload length`，未到 JS 的确认层。该版本的 POSIX native parser 将 V8 字节流按 NUL 分段并 trim ASCII whitespace，再拼接校验声明长度；two-byte 字符串中的 NUL 后空格会丢失。同原 runtime 的生产工厂/V8 合同已重放232→231字节，ASCII、中文无空格、已编码URI为完整对照。此问题与已修异步 ACK/确认排队分列。

`desktopDeepLinkUrl` 是无状态 wire 编解码的唯一 owner。继续保留 `deepLinkUrl`、`openWorkspacePath` 两个逻辑字段及既有优先级。安全可打印ASCII（0x20到0x7e）的值原样传递，包括正常内空格与URL percent，保持旧receiver原本有效的ASCII入口；包含非ASCII、NUL/控制字符或与wire命名空间冲突的值才编码成 `uwork-si:v1:` 加 `encodeURIComponent(value)` 的 ASCII wire。不增加队列/缓存、不删除 additionalData、不修改单实例锁、确认 gate 或 Electron/fuse。完整值只在原提取器识别已知版本时 decode 一次；URL 中既有 percent encoding 保留到原 URL parser，不能重复解码路径或提前放行。

可打印ASCII内容不保证V8 OneByte存储：Unicode外壳的slice/trim可能留下SlicedTwoByteString，即使逐字符相同也仍会在序列化后含NUL+space。ASCII原值分支必须在已验证ASCII后通过 `node:buffer` 进行无损OneByte重新分配，再返回相同逻辑文本；不依赖JS字符串内部表示或通过替换Unicode求绿。永久测试包含wide slice和Unicode外壳trim两个实际来源，同runtime真实V8也须验证。

新提取器继续接受无 wire 前缀的旧 raw 对象。属于 `uwork-si:` 家族但版本未知、payload含非ASCII或坏percent/UTF8的值拒绝为 null，由原 dispatcher 的 argv fallback 继续处理。未带该家族前缀的 legacy 值仍走原参数校验。新wire不是安全授权，解码后继续全部原 URL/绝对目录/NUL/UNC校验与外部确认，不能通过传输标记绕过用户确认。新receiver兼容legacy raw；旧receiver的正常ASCII目录与URL继续由原提取器读取，不将可避免的ASCII回归留作未验边界。旧receiver读取新增nonASCII wire及完整跨版本native共存仍不计作已验迁移。

原 argv 若包含不能由 `encodeURIComponent` 表达的孤立 surrogate，只不生成该无效字段的 wire 值，工厂不抛错、不替换 Unicode、不改 argv；原 argv fallback 与后续目录合法性校验仍负责拒绝。有效的另一个字段不受影响。

永久测试必须先在旧生产工厂上取得中文空格 V8/native-framing roundtrip RED，再验证新生产工厂与提取器、同runtime重放及原 cold/ready确认链。覆盖中文/空格/emoji/字面百分号、URL双重percent、多种长度、字段并存优先级、legacy raw、坏/未知版本、NUL/UNC在原边界继续拒绝；不能只断言encoder的输出形状或仅用模拟对象替代真实V8 bytes。原macOS新包再复测失败的可信baseline和25秒/第三URI/取消确认，全平台结论仍按实际环境分列。
