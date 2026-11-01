#!/bin/bash
set -e

# RPM 升级的旧包 postun 仍有实例（$1 非零），不能拆掉新包刚注册的链接和资源。
if [ "${1:-0}" != "0" ]; then
    exit 0
fi

INSTALL_ROOT='/opt/${sanitizedProductName}'

# 原工具对缺失条目返回 2；从成功的只读查询区分幂等缺席与真实工具错误，不能吞错误。
has_owned_group() {
    while read -r group rest; do
        if [ "$group" = '${executable}' ]; then return 0; fi
    done
    return 1
}
has_owned_target() {
    while IFS= read -r entry; do
        case "$entry" in "$INSTALL_ROOT/${executable} - priority "*) return 0 ;; esac
    done
    return 1
}

if type update-alternatives >/dev/null 2>&1; then
    REGISTERED_GROUPS=$(LC_ALL=C update-alternatives --list)
    if printf '%s\n' "$REGISTERED_GROUPS" | has_owned_group; then
        REGISTERED_TARGETS=$(LC_ALL=C update-alternatives --display '${executable}')
        if printf '%s\n' "$REGISTERED_TARGETS" | has_owned_target; then
            # 原模板误传 /usr/bin 链接名，必须删除安装时相同的实际 target。
            update-alternatives --remove '${executable}' "$INSTALL_ROOT/${executable}"
        fi
    fi
fi

# 同时覆盖工具缺失/安装曾回退的直接链接，只删除本应用确切 target。
if [ -L '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" = "$INSTALL_ROOT/${executable}" ]; then
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
    rm -f "$APPARMOR_PROFILE_DEST"
fi

# RPM 清单删除文件后可能留下空目录；只删本应用空树，不动非空内容或跟随符号链接。
if [ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ]; then
    find "$INSTALL_ROOT" -depth -type d -empty -delete
fi
