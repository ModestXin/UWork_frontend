export interface NodePtyPrebuildAssets {
  readonly version: string;
  readonly platformKey: string;
  readonly nativePath: string;
  readonly spawnHelperPath?: string;
}
export function resolveNodePtyNativePath(nativePackageRoot: string, platformKey: string): string;
export function resolveNodePtyPrebuildAssets(options: {
  jsPackageRoot: string;
  nativePackageRoot: string;
  platformKey: string;
}): NodePtyPrebuildAssets;
