import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { ZCODE_AGENT_CA_CERT_ENV_KEY } from "@zcode/shared";
import { loadTlsCaCertificates } from "../src/network/http-config.js";
import { createNodeHttpClientAdapter } from "../src/http/index.js";
import { createNetworkProxyFetch } from "../src/network/proxy-fetch.js";

const execute = promisify(execFile);
let directory: string, trusted: string, untrusted: string;
before(async () => {
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0", "strict TLS must remain enabled");
  directory = await mkdtemp(join(tmpdir(), "uwork-ca-unit-"));
  for (const name of ["trusted", "untrusted"]) {
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=owned-ca-test", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(directory, name + ".key"), "-out", join(directory, name + ".pem")]);
  }
  trusted = join(directory, "trusted.pem"); untrusted = join(directory, "untrusted.pem");
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const fingerprints = (bundle: string | Buffer) => new Set((bundle.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map(pem => new X509Certificate(pem).fingerprint256));
const untrustedCertificate = (error: unknown) => error instanceof Error && /self[- ]signed|local issuer|unable to verify/i.test(error.message);

test("custom CA appends trust without removing any normal Node root", async () => {
  const loaded = loadTlsCaCertificates({ caCertFile: trusted });
  assert.ok(Buffer.isBuffer(loaded));
  const actual = fingerprints(loaded);
  assert.ok(actual.has(new X509Certificate(await readFile(trusted)).fingerprint256));
  for (const root of rootCertificates) assert.ok(actual.has(new X509Certificate(root).fingerprint256), "Configured custom CA removed a normal Node trust root");
});
test("no custom path remains undefined; file precedence, env and read failures are unchanged", async () => {
  assert.equal(loadTlsCaCertificates({ env: {} }), undefined);
  assert.equal(loadTlsCaCertificates({ caCertFile: " ", env: {} }), undefined);
  const loaded = loadTlsCaCertificates({ caCertFile: trusted, env: { [ZCODE_AGENT_CA_CERT_ENV_KEY]: untrusted } });
  assert.ok(loaded);
  assert.ok(fingerprints(loaded).has(new X509Certificate(await readFile(trusted)).fingerprint256));
  assert.ok(!fingerprints(loaded).has(new X509Certificate(await readFile(untrusted)).fingerprint256));
  assert.ok(fingerprints(loadTlsCaCertificates({ env: { [ZCODE_AGENT_CA_CERT_ENV_KEY]: trusted } })!).has(new X509Certificate(await readFile(trusted)).fingerprint256));
  assert.throws(() => loadTlsCaCertificates({ caCertFile: join(directory, "missing.pem") }), { code: "ENOENT" });
});
test("an empty configured custom bundle still retains normal Node roots", async () => {
  const path = join(directory, "empty.pem"); await writeFile(path, "");
  const loaded = loadTlsCaCertificates({ caCertFile: path }); assert.ok(loaded);
  assert.ok(fingerprints(loaded).has(new X509Certificate(rootCertificates[0]!).fingerprint256));
});

test("both production clients keep strict custom-CA TLS direct and through an owned CONNECT", async () => {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); };
  const urls: string[] = [], servers: ReturnType<typeof createHttpsServer>[] = [];
  let rejectedHttpRequests = 0;
  const proxy = createHttpServer(); proxy.on("connection", track);
  try {
    for (const name of ["trusted", "untrusted"]) {
      const server = createHttpsServer({ key: await readFile(join(directory, name + ".key")), cert: await readFile(join(directory, name + ".pem")) }, (_request, response) => {
        if (name === "untrusted") rejectedHttpRequests++;
        response.writeHead(200, { "content-type": "text/plain", connection: "close" }); response.end("owned TLS");
      });
      server.on("connection", track); server.on("tlsClientError", () => {});
      servers.push(server);
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const address = server.address(); assert.ok(address && typeof address !== "string");
      urls.push(`https://127.0.0.1:${address.port}/catalog`);
    }
    proxy.on("connect", (request, client, head) => {
      if (!urls.some(value => new URL(value).host === request.url)) { client.destroy(); return; }
      const port = Number(request.url!.split(":")[1]);
      const upstream = connect(port, "127.0.0.1"); track(upstream);
      upstream.once("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    });
    await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
    const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== "string");
    for (const proxyUrl of [undefined, `http://127.0.0.1:${proxyAddress.port}`]) {
      const http = createNodeHttpClientAdapter({ env: {}, caCertFile: trusted, proxyUrl, timeoutMs: 2000 });
      const response = await http.request({ url: urls[0]!, method: "GET" });
      assert.equal(response.status, 200); assert.equal(Buffer.from(response.body).toString(), "owned TLS");
      await assert.rejects(http.request({ url: urls[1]!, method: "GET" }), untrustedCertificate);
      const fetch = createNetworkProxyFetch({ env: {}, caCertFile: trusted, httpProxy: proxyUrl });
      const fetched = await fetch(urls[0]!, { signal: AbortSignal.timeout(2000) });
      assert.equal(fetched.status, 200); assert.equal(await fetched.text(), "owned TLS");
      await assert.rejects(fetch(urls[1]!, { signal: AbortSignal.timeout(2000) }), untrustedCertificate);
    }
    assert.equal(rejectedHttpRequests, 0, "an unrelated root must fail before HTTP reaches the server");
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, ...servers].map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))));
  }
});
