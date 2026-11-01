# Linux pacman 压缩格式

2026-10-20 原完整 Linux producer 生成名为 .pkg.tar.zst 的文件，但实际魔数 fd377a58（xz），原格式验收失败。文件名本身不能保证内容类型。

electron-builder.config.js 是包名/格式的唯一配置 owner。当前 electron-builder 26.8.1 通用 compression 枚举没有 zstd，不能塞入不支持的值或修改 vendor；复用现有 pacman.fpm 透传 --pacman-compression zstd，在原默认参数之后明确选择 FPM 支持的 zstd。保留现有 Preview/Production 包名隔离、Arch 依赖、文件名、安装/卸载脚本和原应用内容，不手工重压缩产物。

验收沿原完整 --linux --arm64 --prepackaged --publish never：旧产物保留 RED，新产物须具有 zstd 魔数 28b52ffd、可解包 .PKGINFO、正确包名/版本/aarch64，五个核心运行时文件与已验源包一致。AppImage/deb/rpm 同批格式与内容也核验。打包配置类型/Lint/架构/格式按原门禁执行，不降低原消费方断言，也不据格式验证声称 Arch 实机安装通过。
