# Server 发行归档的安装属主

ReleaseInstaller / ComponentCache 仍是安装和更新提取的唯一入口。归档内 uid/gid 来自发布机，不能在目标机要求恢复这些身份；实际安装文件归当前安装进程所有。Linux root 在没有 CAP_CHOWN 的容器中也应能安装有异机属主元数据的合法发行包。

原路径、软/硬链接、目标架构、版本和 SHA 校验全部保留。tar 仅在完成路径/链接校验后的实际提取阶段禁止恢复归档属主，不增加权限或关闭安全检查。ZIP 原路径不变。不修改归档内容或 manifest 版本，不建立第二条提取路径。

验收：

1. 在 Linux root、CAP_CHOWN 已移除的真实进程中，创建 uid501/gid50 的普通文件归档；原 extractArchiveSafely 提取成功、文件正文和执行位保留、目标 uid/gid 为安装者。旧实现实际失败，新实现成功。
2. 同环境的归档链接和越界路径仍被拒绝。
3. 原 Server CLI 在线 update 使用真实 Linux ARM64 原发行归档，不接外网；坏 SHA 和 catalog/包版本不一致均拒绝且 current/原 Core 可用。不同 SHA 的同版构建确实替换，匹配 SHA 的重试不下载归档、不重启 Core。由于保留旧/新包 manifest 都为3.16.0，不能据此声称跨版本升级。
4. 类型、Lint、架构、格式及正常 Server 构建通过；保持归档、临时安装前缀和测试资源的所有权与收尾证据。
