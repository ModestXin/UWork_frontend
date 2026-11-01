# Server 发行版本一致性

原 `stageCli` 从仓库根 package.json 读取 appVersion 写入发行 manifest。Server CLI/Core 的 `ZCODE_VERSION` 也必须由同一文件的 version 在正常构建时注入，不能在正式 stage 后仍回退到 `0.0.0-dev`。

构建配置拥有编译期常量；运行时继续读取共享 `ZCODE_VERSION`，不读取外部 package.json、不引入第二套版本状态。现有安装器核对归档 manifest 版本，Supervisor 的 ready 等待只判断生命周期状态，并未比较 Core 报告版本；本改动修复实际运行版本的可识别性，不新增更新拒绝规则，也不声称已复现版本不符导致更新失败。

验收：读取实际 tsup 配置构建包含原共享 version.ts 的最小入口，独立 Node 执行结果必须等于根 package.json.version；旧配置为 RED。正常 Server 两产物重建后，发行树 manifest、原 status 和 HTTP server-info 的版本一致。旧失败包保留，不能修改其 manifest 来满足断言。
