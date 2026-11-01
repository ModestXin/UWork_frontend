# 增量组装保留发行 manifest 原文字节

Runtime manifest 的语义由既有严格 schema 验证，发行目录的不可变身份继续包含每个文件的精确字节和执行位。原 stage producer 的组件字段顺序为 id/paths/sha256，schema parse 会输出 id/sha256/paths；将 parse 结果重新序列化会让增量组装与同一原整包的 manifest 字节不同，导致后续整包 fallback 正确触发不可变冲突。

同一次原 HTTP JSON 下载在校验语义的同时保留文档原文，并交给既有 ComponentCache 组装所有者写入。写入前重新严格解析原文并与已验证的 runtimeManifest 结构一致，禁止用不匹配的原文替换 manifest。没有原文的既有内部调用保持既有序列化行为。

不忽略 manifest 的完整性、不按语义放松 immutable tree 比较、不重写原归档、不增加第二份 current/pending 状态。下载超时、版本/架构/摘要与路径/链接检查保持原入口。

验收：

1. 实际 HTTP 提供原 producer 顺序的 runtime manifest 和组件归档，原 prepareOnlineUpdate + ComponentCache 组装应保留原文字节。
2. 对同一已组装 release 调原 ReleaseInstaller 安装相同原整包应验证复用成功；篡改已安装正文仍不可复用。旧实现至少原文字节/复用断言RED，新实现GREEN。
3. 不匹配的 manifest 原文在组装前拒绝，不能用此修复绕过严格 schema 或不可变校验。
4. 正常构建/stage后的原旧包→新组件、坏组件摘要拒绝及缺URL整包fallback、再安装仍以真实CLI/HTTP验证。两原发行版本均3.16.0，只证明同版构建切换，不声称跨版本升级。
