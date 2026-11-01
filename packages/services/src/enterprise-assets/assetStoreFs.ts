import { constants } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EnterpriseAssetStoreError } from "./assetPackage.js";

const MAX_TREE_ENTRIES = 2200;
export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
export async function assertDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new EnterpriseAssetStoreError("enterprise_asset_path_unsafe");
  return info;
}
export async function assertRootPath(root: string) {
  let path = resolve(root);
  for (;;) {
    await assertDirectory(path);
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  if ((await realpath(root)) !== root)
    throw new EnterpriseAssetStoreError("enterprise_asset_path_unsafe");
}
export async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum)
    throw new EnterpriseAssetStoreError("enterprise_asset_file_unsafe");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    )
      throw new EnterpriseAssetStoreError("enterprise_asset_file_unsafe");
    const buffer = Buffer.alloc(maximum + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
    }
    if (bytes > maximum) throw new EnterpriseAssetStoreError("enterprise_asset_limit");
    return buffer.subarray(0, bytes);
  } finally {
    await handle.close();
  }
}
export async function assertOptionalLock(path: string) {
  try {
    await assertDirectory(path);
    const names = await readdir(path);
    if (names.length > 8) throw new EnterpriseAssetStoreError("enterprise_asset_tree_unsafe");
    for (const name of names) {
      if (!/^owner-[A-Za-z0-9-]+\.json$/.test(name))
        throw new EnterpriseAssetStoreError("enterprise_asset_tree_unsafe");
      const info = await lstat(join(path, name));
      // 正常 release 会在预检期间 unlink owner；消失/零链接不是稳定的危险锁。
      if (info.nlink === 0) continue;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096)
        throw new EnterpriseAssetStoreError("enterprise_asset_file_unsafe");
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
}
export async function assertExactTree(
  directory: string,
  files: readonly { path: string; content: string }[],
) {
  await assertDirectory(directory);
  const expected = new Map(files.map((file) => [file.path, Buffer.from(file.content)]));
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.path.split("/");
    for (let length = 1; length < segments.length; length++)
      directories.add(segments.slice(0, length).join("/"));
  }
  const pending = [{ path: directory, relative: "" }];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    await assertDirectory(current.path);
    for (const name of await readdir(current.path)) {
      if (++entries > MAX_TREE_ENTRIES)
        throw new EnterpriseAssetStoreError("enterprise_asset_limit");
      const relative = current.relative ? `${current.relative}/${name}` : name;
      const path = join(current.path, name),
        info = await lstat(path);
      if (info.isSymbolicLink())
        throw new EnterpriseAssetStoreError("enterprise_asset_path_unsafe");
      if (info.isDirectory() && directories.delete(relative)) pending.push({ path, relative });
      else if (info.isFile() && expected.has(relative)) {
        const bytes = expected.get(relative)!;
        if (!(await readBoundedFile(path, bytes.length)).equals(bytes))
          throw new EnterpriseAssetStoreError("enterprise_asset_checksum");
        expected.delete(relative);
      } else throw new EnterpriseAssetStoreError("enterprise_asset_tree_unsafe");
    }
  }
  if (expected.size || directories.size)
    throw new EnterpriseAssetStoreError("enterprise_asset_tree_unsafe");
}
