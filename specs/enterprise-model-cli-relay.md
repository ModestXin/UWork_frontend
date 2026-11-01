# 企业会话模型的 CLI 私有传输

私有 `open` 必须携带 64 位十六进制 `ownerKey`，取自既有模型调用第一次 Host 准入的 ALS 绑定。ModelDispatchGuard 只提供同步只读 getter；session fetch 在请求准备之后读取原绑定，缺失时拒绝，不能重新捕获当前新身份。Host 在同一个 backendSession.run scope 内、构造/派发请求之前比较该证明与 scope.ownerKey，打开流之后和每次 read 继续检查当前身份。缺失/非法证明及旧端版本组合明确 fail-closed，不降级。read/close 不改；该字段不进入公共 HTTP/V4、模型消息、VM、header 或持久化，也不增加身份/允许缓存。

2026-10-17 用户约束：登录和模型凭据属于 Host/后端，CLI、Renderer 只提交模型 ID、上下文和请求参数，不能获得企业身份会话、device token 或供应商 Key。个人 API-key 与 legacy UCAS 行为保持现有边界。

`enterprise-session` 是显式 Provider access 模式。CLI 不尝试读取 Key 或回退直连；缺少受信 Host relay 即在创建模型时拒绝。CLI 继续使用同一 AI SDK、参数 maps、重试/取消/计量处理；只有 HTTP transport 被替换为私有 Host RPC。

```mermaid
sequenceDiagram
  participant C as CLI runtime / AI SDK
  participant P as 私有 RPC Port
  participant H as Host 身份/stream owner
  participant B as 后端模型网关
  C->>P: open(url, JSON body, ownerKey; runtime/workspace/session)
  P->>H: interactionEnterpriseModelRequest
  H->>B: 按当前身份鉴权；凭据仅在 Host 内存
  H-->>C: streamId, HTTP status, contentType
  loop 有界顺序拉取
    C->>H: read(streamId)
    H-->>C: base64 bytes, done
  end
  C->>H: close(streamId) 或既有取消通知
```

Host 是远端流的唯一所有者，CLI 仅持有当前 Response 的 streamId 与流读取状态，不建持久队列、授权缓存或第二份身份。每次 RPC 都绑定当前 runtime session、workspace identity 和 trace。open/read 单个请求取消沿既有 enterpriseToolAuthorizationCancelled 通知到 Host；已有 stream 的 abort、consumer.cancel、正常 EOF 或失败都 best-effort close。open 尚未返回也必须发送取消，不等待拿到 streamId。迟到 open 返回的 streamId 必须关闭且不作为成功 Response 暴露。

Relay fetch 只接受 POST、HTTP(S) URL 和 JSON 字符串正文；不转发任何请求 header 或认证参数。Host 独立校验唯一 backend origin/path、当前身份、正文和资源限额。RPC result 经共享 schema 校验，最多 64KiB 单块，按原字节拼接，不能按 chunk 解码 UTF-8 导致多字节切分损坏。非 2xx HTTP 作为正常 Response 交 AI SDK；Host denied 作为失败，不伪装空 completion。

取消只证明 CLI 与本地 Host/后端连接及时中止；已派发上游的费用可能不确定，不能承诺回滚或退款。旧 Native 直连曾观察 UI cancelled 而 backend 晚结算，但相同 Node/打包 CLI 的独立实测未复现根因；该历史现象不当作新 relay 的通过证据。

验收：真实 AI SDK JSON/SSE（含多字节 byte 分片）、缺 relay fail-closed、取消 open/read、正常 EOF 清理、denied 和 HTTP 错误、逐次 owner 撤销；实际打包 CLI stdio 只传正文与绑定标识且绝不包含任何身份/供应商凭据，配合独立 TCP/文件后端与受控本机供应商计数/账本；Native UI 为独立实测边界。

附带工厂修复：独立传入的 `beforeDispatch` 原被 `createModelAdapter` 忽略，只展开 executionConfig。现优先传入该私有 guard，缺省复用 executionConfig 中的 guard；真实受控个人 HTTP 回归证明拒绝时供应商零调用。此修复不改变个人/legacy 的 Provider 配置或凭据所有者。
