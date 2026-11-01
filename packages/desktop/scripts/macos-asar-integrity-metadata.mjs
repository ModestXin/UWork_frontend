import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { readAsarHeader } = require("app-builder-lib/out/asar/asar.js");
const plist = require("plist");
const integrityKey = "Resources/app.asar";

export async function synchronizeMacAsarIntegrityMetadata({ electronPlatformName, appAsarPath }) {
  if (electronPlatformName !== "darwin") return;

  const infoPath = join(dirname(appAsarPath), "..", "Info.plist");
  const info = plist.parse(await readFile(infoPath, "utf8"));
  const integrity = info?.ElectronAsarIntegrity;
  const entry = integrity?.[integrityKey];
  if (
    !integrity ||
    typeof integrity !== "object" ||
    Array.isArray(integrity) ||
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry)
  ) {
    throw new Error("Mac bundle is missing its app.asar integrity declaration");
  }

  const { header } = await readAsarHeader(appAsarPath);
  // afterPack 会重包 ASAR；必须在签名前对最终原 UTF8 header 散列，不能重排 JSON 或包含 Pickle padding。
  JSON.parse(header);
  const hash = createHash("sha256").update(header, "utf8").digest("hex");
  if (entry.algorithm === "SHA256" && entry.hash === hash) return;

  integrity[integrityKey] = { ...entry, algorithm: "SHA256", hash };
  await writeFile(infoPath, plist.build(info), "utf8");
}
