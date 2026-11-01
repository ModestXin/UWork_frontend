# Desktop node-pty 的 JS/native 一致性

原 Linux 原包真实终端输入可用，但 resize 日志要求 `pty.resize(fd, cols, rows, xPixel, yPixel)`。原包 JS 是 node-pty1.1.0，公开 resize 两参数后向 native 传三参数；beforePack 却从 @lydell 平台包1.2.0-beta.10无条件复制 native。使用原AppImage提取JS和同SHA native、匹配Linux Node实测三参数抛 Usage，五参数才进入 ioctl/EBADF，构成真实ABI不一致。

Desktop 固定 JS node-pty1.1.0 与两个 Linux 平台原包1.1.0。官方registry同时提供arm64/x64对应原包与完整integrity；不修改第三方JS/native源码，不改变TerminalService公开resize接口，不吞错误。Darwin现有1.1 JS/native保持；原Desktop单独修复切片未改变Server/CLI的Beta10依赖。随后Server三producer及四平台匹配修复由[独立Server规格](server-node-pty-native-compatibility.md)接续，当前Server JS/四native均固定1.1.0；已有cdf Agent仍不重建。

唯一写者仍为原 `restoreTargetNodePtyPrebuild`。它从调用者Desktop项目根解析JS和目标平台包，复制前核JS/native版本非空且精确相同、源平台包名、os/cpu与目标一致、真实ELF64 little-endian及machine与目标一致；任何不一致必须失败，已有目标字节不变。原公开入口和pnpm解析应支持workspace内Desktop与Server不同依赖版本，不能用宿主root hoist碰巧选到正确版本。

正常路径为：明确目标与Desktop依赖 → 原beforePack验证唯一JS/native组合 → 复制原native → 原builder/asarUnpack/权限 → 实际包消费。没有新的运行时状态、RPC、备用调用路径或像素参数兼容分支。非Linux仍按原路径跳过此Linux资产恢复，不覆盖其他平台资源。

## 验收

- 真实临时项目调用原函数：匹配arm64/x64复制成功；版本、名称、缺metadata、os/cpu、ELF不匹配均在写入前拒绝；旧target和Darwin资产保持；声明/锁文件与实际Desktop/Server解析分别验证。
- 同一实际1.1 JS公开resize、同Linux Node环境，原beta native三参数Usage RED，匹配1.1 native三参数到ioctl EBADF GREEN；只用无效fd的探针不创建PTY或子进程。
- 匹配组合实际spawn PTY，两次公开resize后真实shell stty size分别等于所需rows/cols，收口自有shell/container。
- 正常新Linux原包的原UI终端fit/拖动尺寸后shell stty size真实改变，shell PID/TTY/cwd不变，日志不再出现resize Usage；原文件/重载、两笔模型/本人账本/撤席位、25秒协议并发链继续按原断言验证。旧中断候选/旧输入成功不代替resize通过。
- 必要类型、Lint、架构及相关原打包回归据实际结果报告；不为通过而删除断言、关闭sandbox或改阈值。
