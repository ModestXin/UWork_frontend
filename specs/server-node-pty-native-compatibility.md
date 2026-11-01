# Server / Agent 构建资产的 node-pty 一致性

Linux Server 原3b50归档实测 JS1.1.0公开resize传3参，原Beta10 native要求5参；原Node22无效FD合同真实RED。Darwin旧d365/新1d3原公开3参均EBADF，通过；不推广Linux故障，也不修改Terminal公共API或第三方源码。

Server固定node-pty及darwin-arm64/darwin-x64/linux-arm64/linux-x64四个@lydell平台包到1.1.0。原cdf Agent不重建；pnpm-lock仍由协调者统一更新，Desktop已通过24项旧合同作为历史保留。

唯一只读事实源为根scripts的共享构建资产解析器，接显式JS包root、native包root和目标，不从全局hoist猜版本。读取name/version/os/cpu，要求JS/native非空精确同版、native名与目标相符；拒绝不支持目标、错误ELF64 endian/machine、错误Darwin Mach-O CPU。官方1.1 flat pty.node与Beta的prebuilds/<target>/pty.node可以解析，但必须唯一，双布局拒绝；Darwin spawn-helper必须来自同一选中布局、存在且架构正确。返回只读canonical资产计划，不持有缓存/写目标/运行native。

三个原producer仍各自唯一writer：

1. Server CLI staging先校验目标JS/native计划，不能因已有目标pty.node而跳过；按计划更新目标native和Darwinhelper。原Windows路径不改。
2. Agent分发assets先校验四平台计划再写，避免后一个错误使前一个目标被污染；不无条件复制整个任意prebuild目录，不缺包warning后冒称成功。
3. 原prepare-prebuilds同样先校验四平台，明确重建本版本自有node-pty目标目录，不能因pty/helper存在即复用旧Beta。组件semanticPrefix读取同一已验证包版本，原content hash继续由实际最终字节生成；禁止旧内容贴新版本。

Desktop保留原restore入口/同步行为、非Linuxskip及其余23项断言；只把共用解析逻辑移出，Root授权的ServerBeta隔离旧断言改为新Server五个精确1.1pins断言，不删除测试或降约束。共享模块为构建IO层，不进入runtime或RPC，不新增状态、第二资产表或备用工具路径。

事件顺序：显式输入 → 全组只读校验 → 原writer复制/权限 → 原manifest/content hash → 正常原包消费。所有拒绝在本次目标复制前发生，原源字节不变；旧缓存不构成认可依据。Darwin目标helper必须0755；原notices按现有流程重建。不得运行远端provider/部署/模型探针以验证本修复。

验收：永久真实临时文件测试覆盖flat1.1、四平台、旧Beta目标强制替换、版本/名称/os/cpu/目标header错误、双布局、缺/错Darwinhelper、全组拒绝不半写，以及原三个producer；保留原Linux真实模块RED与原DarwinGREEN。正常新Server原producer、原本地SDK PTY两次stty/更新后复测与资源闭合属于后续明确排期，不以单位测试替代。必要typecheck/lint/architecture与原Desktop24及相关打包测试不降低。

解析器保留原Desktop与prepare构建入口的同步读取合同，不用于运行时请求路径；异步producer继续使用原异步复制API。原stageRelease整体重建私有发行目录的语义不变，所述拒绝前不写指node-pty规范化资产替换前，不把未发布的临时staging冒充旧安装目录事务回滚。
