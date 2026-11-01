import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_FILES = 100;
const MAX_PATH_DEPTH = 20;
const validUnicode = (value: string) => !/[\ud800-\udfff]/u.test(value);
const text = (maximum: number) => z.string().max(maximum).refine(validUnicode);
const pathSchema = text(240)
  .min(1)
  .refine((path) => {
    if (path.startsWith("/") || /[\\:<>"|?*\p{Cc}]/u.test(path) || path !== path.normalize("NFC"))
      return false;
    const segments = path.split("/");
    return (
      segments.length <= MAX_PATH_DEPTH &&
      segments.every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          !segment.startsWith(" ") &&
          !/[. ]$/.test(segment) &&
          !/^(CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3])$/.test(
            segment.split(".")[0]!.trimEnd().toUpperCase(),
          ),
      )
    );
  });
const skillContentSchema = z
  .object({
    files: z
      .array(z.object({ path: pathSchema, content: text(500000) }).strict())
      .min(1)
      .max(MAX_FILES),
    highRisk: z.boolean(),
  })
  .strict()
  .refine((content) => {
    const paths = content.files.map((file) => file.path.toUpperCase().normalize("NFC"));
    return (
      content.files.some((file) => file.path === "SKILL.md") &&
      new Set(paths).size === paths.length &&
      paths.every((path) => !paths.some((other) => other.startsWith(`${path}/`)))
    );
  });
const binding = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
};
export const assetPackageSchema = z.discriminatedUnion("kind", [
  z.object({ ...binding, kind: z.literal("skill"), content: skillContentSchema }).strict(),
  z
    .object({
      ...binding,
      kind: z.literal("expert"),
      content: z
        .object({
          instructions: text(100000).min(1),
          profession: text(256).optional(),
          modelId: text(256).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...binding,
      kind: z.literal("playbook"),
      content: z.object({ markdown: text(100000).min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      ...binding,
      kind: z.literal("instruction"),
      content: z.object({ instructions: text(100000).min(1) }).strict(),
    })
    .strict(),
]);
export type EnterpriseAssetPackage = z.infer<typeof assetPackageSchema>;
export type EnterpriseAssetBinding = Pick<
  EnterpriseAssetPackage,
  "id" | "kind" | "version" | "checksum"
>;
export interface EnterpriseAssetReference {
  key: string;
  asset: EnterpriseAssetBinding;
  directory: string;
}
export interface EnterpriseAssetOperation {
  readonly traceId: string;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}
export class EnterpriseAssetStoreError extends Error {
  constructor(
    readonly code: string,
    readonly traceId?: string,
  ) {
    super(code);
    this.name = "EnterpriseAssetStoreError";
  }
}
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const assetBinding = (asset: EnterpriseAssetBinding): EnterpriseAssetBinding => ({
  id: asset.id,
  kind: asset.kind,
  version: asset.version,
  checksum: asset.checksum,
});
export const assetKey = (asset: EnterpriseAssetBinding) =>
  digest(JSON.stringify(assetBinding(asset)));
export function parseAssetPackage(input: unknown): EnterpriseAssetPackage {
  const parsed = assetPackageSchema.safeParse(input);
  if (!parsed.success) throw new EnterpriseAssetStoreError("enterprise_asset_invalid");
  const encoded = JSON.stringify(parsed.data.content);
  if (Buffer.byteLength(encoded) > MAX_ASSET_BYTES)
    throw new EnterpriseAssetStoreError("enterprise_asset_limit");
  if (digest(encoded) !== parsed.data.checksum)
    throw new EnterpriseAssetStoreError("enterprise_asset_checksum");
  return parsed.data;
}
export function assetFiles(
  asset: EnterpriseAssetPackage,
): readonly { path: string; content: string }[] {
  if (asset.kind === "skill") return asset.content.files;
  if (asset.kind === "expert")
    return [{ path: "expert.json", content: JSON.stringify(asset.content) }];
  if (asset.kind === "playbook") return [{ path: "PLAYBOOK.md", content: asset.content.markdown }];
  return [{ path: "INSTRUCTIONS.md", content: asset.content.instructions }];
}
export function assertCurrent(operation: EnterpriseAssetOperation) {
  if (operation.signal?.aborted) throw new EnterpriseAssetStoreError("enterprise_asset_cancelled");
  if (!operation.isCurrent()) throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
}
