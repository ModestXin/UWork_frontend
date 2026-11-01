# Desktop Main 编译前类型检查收口

根 `pnpm typecheck` 原先仅包含 Desktop Host，Main 的独立严格检查实际有83个诊断。本轮保持 strict、noUncheckedIndexedAccess 等原检查不变，不新增 any/ts-ignore、不排除失败源码、不用跳过测试代替修复。

按已有所有者合同修复：

- Main 使用的 shared、scheduler 协议源纳入正确 rootDir/include；通过 Playwright 发给页面执行的 DOM 回调需要 DOM 标准类型。运行时代码仍由原 tsup/Vite 输出，类型配置不负责替换原运行入口。
- 共享类型通过已有公开入口导出；Storage 类型从其唯一源 shared/公开 services contract 导入。
- 可选值在使用前证明存在，保持取消/空集合/未知结果语义。涉及实际校验的修改必须有边界回归，不将未知输入断言为成功。
- 浏览器动作保持原判别联合与准入，不能把不适用操作当点击；WebContents事件签名遵循当前锁定 Electron 类型。
- Node/Electron网络和二进制接口按真实参数类型桥接；协议与调用合同不通过宽泛强制转换放松。

每组修复运行 Main 独立检查，记录剩余诊断。最终将 Main 检查接入可重复的源码门禁；平台安装包与跨系统运行仍不在本轮范围。


Main 中继的事件类型改为从现有 `taskRealtime*Schema` 推导的 wire 类型：schema 原本只校验 envelope 并透传内容，不能在 Main 强称已获得完整 `ZCodeStreamEvent`。业务类型、schema、传输内容和 owner/lease 不放宽也不更换；仅文本合并/拆分分支显式要求字符串。两个交付角色（desktop_window/relay_bridge）均验证未知事件透传、文本合并、连续 seq 和终态后拒绝派发。

正常构建会清空 Server 声明文件但留下旧增量记录；`scripts/typecheck-desktop-main.mjs` 显式生成引用声明，再以 `--noEmit` 检查 Main。默认 `pnpm typecheck` 调用此脚本，不能再只通过 Host 检查就跳过 Main。新增源码门禁不生成/测试操作系统安装包。
