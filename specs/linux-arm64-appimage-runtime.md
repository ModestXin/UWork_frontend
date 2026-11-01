# Linux ARM64 AppImage 运行时

2026-10-20 原配置采用 electron-builder 26.8.1 的默认 legacy AppImage 工具集。真实 ARM64 产物的 --appimage-offset 在只有常规 zlib 运行库的环境报缺 libz.so，连标准解包入口也不能执行；不能靠给验收环境安装开发包或手工改写 AppImage 通过。

原 electron-builder.config.js 继续唯一选择工具集，仅 Linux ARM64 使用该固定版本声明支持的 toolsets.appimage=1.0.2（Runtime 20251108，builder 标记为 Beta）。不升级依赖、不改 vendor，不影响其他架构/平台和包名/身份/业务配置。该路径由 builder 下载并校验固定工具归档，原 producer 生成便携产物。

消费者断言保持：ARM64 ELF/Type2 魔数、原 runtime --appimage-offset/--appimage-extract 成功、五个核心文件与已验包一致、app.asar 版本/Preview 身份正确。使用同一基础运行环境，不能新增 libz.so 开发库掩盖错误。先完成格式与内容验收；真实 GUI、FUSE/提取运行及 URI 投递另列，不把解包成功等同于所有 AppImage 使用场景通过。
