# UWork 企业会话 Provider

2026-10-17 用户要求：不从后台下载模型 API Key，模型请求使用企微登录对应的后台会话。

Provider 配置增加显式 `access: { type: "enterprise-session" }`。该配置没有 Key、Token 或可编辑鉴权头；解析遇到多余凭据字段必须拒绝。类型完整性允许这种无密钥配置进入 Registry，但不能作为已获授权的证明。现有私有 Gateway writer 负责将自有 UWork 托管配置迁移到此模式，移除旧终端令牌；个人和旧 UCAS 配置仍采用既有语义。

迁移复用 `applyUcasGatewayConfig` 同一次 Repository 事务更新访问方式和后端地址；不能先写 Gateway Store 或临时放宽公开固定地址校验。该内部命令增加 `authMode: "enterprise-session"`，拒绝与 apiKey/replaceApiKey 混用，重复同步保持无密钥语义。公开 Service 写口不得让调用方指定该内部模式。

CLI 处理该模式必须通过当前 Host 的私有模型 relay，缺少该端口即拒绝调用。Host 附加 EnterpriseIdentityService 当前会话，固定后端 origin 和 `/v1/chat/completions`；登录 Token 和供应商 API Key 均不返回 CLI/Renderer，也不保存进 Provider。后台仍是成员身份、权限和额度唯一权威。

```mermaid
sequenceDiagram
  participant UI as UWork 界面
  participant CLI as 既有 CLI 模型执行
  participant Host as Host 私有身份会话及 relay
  participant Backend as 自有后端鉴权及计量
  participant Model as 模型供应商
  UI->>CLI: 上下文及模型选择
  CLI->>Host: open 正文 / read 字节流
  Host->>Backend: 私有会话 + 请求正文
  Backend->>Backend: 派生用户及组织、检查权限席位额度
  Backend->>Model: 后台 Vault Key + 上下文
  Model-->>Backend: JSON 或 SSE
  Backend-->>Host: 授权输出
  Host-->>CLI: 有界字节流，无凭据
  CLI-->>UI: 对话投影
```

relay 使用现有 workspace/runtime/session 绑定及取消框架，不另建身份或队列所有者；桌面 continuous 和手机 replayable 均沿用既有同一 CLI/Host 会话。退出、换身份和 CLI/runtime 销毁必须关闭流；每次读取复查原 owner，不能把旧身份响应交给新会话。

登录后的模型引导识别明确的企业会话模式；同步失败也只提示重试或重新登录，不回退为手工模型 Key 输入。旧 UCAS 模式的缺 Key 引导保持原行为。

会话失效等拒绝在界面使用本地化、可操作的提示；稳定内部错误码保留在诊断信息中，不直接作为对话主提示。只映射明确的错误码或完全相等的错误消息，不能按任意文本子串改写其他错误。

验收：无 Key 配置可序列化/反序列化及完整校验；密钥字段被严格拒绝；旧配置切换后不残留 API Key；真实 HTTP/stdio/Native JSON、SSE、取消、退出及权限变更；实际客户端目录、配置、RPC 和日志中均无模型 Key 或私有登录 Token。

## Legacy 创建的完整模型选择

`session/create.model` 是完整的 ModelSelection，包含用户明确提交的 `options.reasoningLevel`。原 App/Runtime 继续是会话选择唯一所有者；创建入口经原 `App.setModel` 传递完整对象，不转为仅含 provider/model 的显示字符串，不新增默认值或第二份选型状态。创建后的严格 snapshot 与原会话选型持久化必须保留该档位。

顺序保持为：原 Registry 初始化校验 → App 设置完整 model → 原独立 thoughtLevel 处理 → snapshot。另传受支持的 thoughtLevel 时仍覆盖 model 中的档位；不受支持的独立 thoughtLevel 沿既有规则忽略并保留完整 model 的原档位。缺失或非法 model 档位仍由原 Registry 拒绝，不因本修复补默认档位或放宽准入。

定向合同调用真实 legacy create handler、生产 App/Runtime/Registry 与严格 snapshot schema，使用独占临时配置和内存存储端口；核对返回当前选择与原持久化数据，覆盖独立 thoughtLevel 的覆盖/忽略及缺档位/非法档位拒绝，不发送模型请求。v4 ACK、Native 或后台联测不替代该 legacy 合同。

## 登录后资料、权限与额度投影

后台 `/api/auth/me` 的本人当前组织 membership 提供企微 UserId 和部门，客户端只展示实际返回资料；自有模式保留 owner/admin/operator/auditor/member 角色并本地化，不合并成普通成员。旧 UCAS 角色仍原样兼容。未实现的职位及 USD 月度预算不在自有 Credit 模式显示为虚构资料。

套餐展示新增有效可用 Credit，直接读取后台 `effectiveAllowance`，不在 UI 重算企业/部门/个人/应用限额。旧 amountTotal/amountUsed 继续作为成员参考值；有效剩余与不可用原因单独突出，不能把参考值当作本次模型可执行额度。没有额度不足并不保证模型最大预留能通过，实际执行仍由后台每次裁决。权限拒绝或会话失效时清掉旧身份的授权投影，网络故障不伪装退出。
