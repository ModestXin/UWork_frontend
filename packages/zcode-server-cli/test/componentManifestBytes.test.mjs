import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createRuntimeManifest, currentServerTarget } from "../src/runtime/manifest.ts";
import { resolveServerLayout } from "../src/runtime/paths.ts";
import { ReleaseInstaller } from "../src/runtime/releaseInstaller.ts";
import { ReleaseManager } from "../src/runtime/releaseManager.ts";
import { prepareOnlineUpdate } from "../src/runtime/updatePreparation.ts";
import { ComponentCache } from "../src/runtime/componentCache.ts";

const execute = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");

for (const format of ["producer", "compact-reversed-keys"]) {
  test(`real component HTTP preparation preserves ${format} manifest bytes and full archive immutable reuse`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "uwork-component-manifest-"));
    const target = currentServerTarget();
    const layout = resolveServerLayout(join(directory, "installation"));
    const previousCatalog = process.env.ZCODE_SERVER_RELEASE_MANIFEST_URL;
    let server;
    try {
      const versions = {};
      for (const [label, body] of [
        ["old", "original-body\n"],
        ["new", "new-body\n"],
      ]) {
        const release = join(directory, label, "zcode-server-fixture");
        await mkdir(join(release, "runtime"), { recursive: true });
        await writeFile(join(release, "runtime/marker.txt"), body);
        const contentSha = sha(
          Buffer.concat([Buffer.from("runtime/marker.txt\0"), Buffer.from(body)]),
        );
        const manifest = createRuntimeManifest(target, "3.16.0", {
          components: [
            {
              id: "server-runtime",
              paths: ["runtime/marker.txt"],
              sha256: contentSha,
              sizeBytes: Buffer.byteLength(body),
            },
          ],
        });
        const rawManifest =
          format === "producer"
            ? JSON.stringify(manifest, null, 2) + "\n"
            : JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse())) + "\r\n";
        await writeFile(join(release, "manifest.json"), rawManifest);
        const archive = join(directory, label + ".tar.gz");
        await execute(
          "tar",
          ["-czf", archive, "-C", join(directory, label), "zcode-server-fixture"],
          { env: { ...process.env, COPYFILE_DISABLE: "1" } },
        );
        versions[label] = {
          release,
          archive,
          rawManifest,
          manifest,
          sha256: sha(await readFile(archive)),
        };
      }
      const componentArchive = join(directory, "component.tar.gz");
      await execute(
        "tar",
        ["-czf", componentArchive, "-C", versions.new.release, "runtime/marker.txt"],
        { env: { ...process.env, COPYFILE_DISABLE: "1" } },
      );
      const componentSha = sha(await readFile(componentArchive));
      let catalog;
      const requests = [];
      server = createServer((request, response) => {
        requests.push(request.url);
        if (request.url === "/catalog") response.end(JSON.stringify(catalog));
        else if (request.url === "/manifest") response.end(versions.new.rawManifest);
        else if (request.url === "/component.tar.gz")
          createReadStream(componentArchive).pipe(response);
        else response.writeHead(404).end();
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const origin = `http://127.0.0.1:${server.address().port}`;
      catalog = {
        schemaVersion: 1,
        releases: [
          {
            version: "3.16.0",
            target,
            archiveUrl: origin + "/full-not-requested.tar.gz",
            archiveSha256: versions.new.sha256,
            manifestUrl: origin + "/manifest",
            components: [
              {
                id: "server-runtime",
                sha256: versions.new.manifest.components[0].sha256,
                sizeBytes: 9,
                archiveUrl: origin + "/component.tar.gz",
                archiveSha256: componentSha,
              },
            ],
          },
        ],
      };
      const installer = new ReleaseInstaller(layout);
      await installer.installArchive({
        archivePath: versions.old.archive,
        target,
        version: "3.16.0",
        archiveSha256: versions.old.sha256,
      });
      await new ReleaseManager(layout).applyPending();
      process.env.ZCODE_SERVER_RELEASE_MANIFEST_URL = origin + "/catalog";
      const preparation = await prepareOnlineUpdate(layout);
      assert.equal(preparation.status, "prepared");
      const pending = await new ReleaseManager(layout).readPending();
      assert.equal(
        await readFile(join(pending.releaseDir, "manifest.json"), "utf8"),
        versions.new.rawManifest,
      );
      assert.deepEqual(requests, ["/catalog", "/manifest", "/component.tar.gz"]);
      await installer.installArchive({
        archivePath: versions.new.archive,
        target,
        version: "3.16.0",
        archiveSha256: versions.new.sha256,
      });
      await writeFile(join(pending.releaseDir, "runtime/marker.txt"), "tampered-body\n");
      await assert.rejects(
        installer.installArchive({
          archivePath: versions.new.archive,
          target,
          version: "3.16.0",
          archiveSha256: versions.new.sha256,
        }),
        /immutable release conflict/,
      );
    } finally {
      if (previousCatalog === undefined) delete process.env.ZCODE_SERVER_RELEASE_MANIFEST_URL;
      else process.env.ZCODE_SERVER_RELEASE_MANIFEST_URL = previousCatalog;
      if (server) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("component assembly rejects a nested manifest source mismatch and preserves legacy no-source serialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uwork-component-source-"));
  try {
    const layout = resolveServerLayout(join(directory, "installation"));
    const baseReleaseDir = join(directory, "base");
    await mkdir(join(baseReleaseDir, "runtime"), { recursive: true });
    const body = "body\n";
    await writeFile(join(baseReleaseDir, "runtime/marker.txt"), body);
    const manifest = createRuntimeManifest(currentServerTarget(), "3.16.0", {
      components: [
        {
          id: "server-runtime",
          paths: ["runtime/marker.txt"],
          sha256: sha(Buffer.concat([Buffer.from("runtime/marker.txt\0"), Buffer.from(body)])),
          sizeBytes: Buffer.byteLength(body),
        },
      ],
    });
    const cache = new ComponentCache(layout);
    const options = {
      target: currentServerTarget(),
      archiveSha256: "a".repeat(64),
      baseReleaseDir,
      runtimeManifest: manifest,
      baseComponents: manifest.components,
      changed: [],
    };
    const mismatched = structuredClone(manifest);
    mismatched.components[0].sha256 = "0".repeat(64);
    const rejected = join(layout.releasesDir, "rejected");
    await assert.rejects(
      cache.assemble({
        ...options,
        releaseDir: rejected,
        runtimeManifestSource: JSON.stringify(mismatched),
      }),
      /source does not match/,
    );
    await assert.rejects(stat(rejected), { code: "ENOENT" });
    await assert.rejects(
      cache.assemble({
        ...options,
        releaseDir: rejected,
        runtimeManifestSource: JSON.stringify({ ...manifest, untrustedExtra: true }),
      }),
    );
    const releaseDir = join(layout.releasesDir, "legacy-no-source");
    await cache.assemble({ ...options, releaseDir });
    assert.equal(
      await readFile(join(releaseDir, "manifest.json"), "utf8"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
