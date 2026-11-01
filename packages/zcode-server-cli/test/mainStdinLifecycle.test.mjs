import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

for (const mode of ["confirmed", "cancelled", "no-confirmation"]) {
  test(`main exits naturally after ${mode} with the input producer still open`, async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-cli-stdin-"));
    let child;
    try {
      await mkdir(join(root, "runtime"));
      await writeFile(join(root, "package.json"), '{"type":"module"}\n');
      const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      await writeFile(join(root, "main.js"), output);
      await writeFile(
        join(root, "runtime/agentWiring.js"),
        "export async function resolveBundledAgentWiring() { return null; }\n",
      );
      await writeFile(
        join(root, "cli.js"),
        `export async function runServerCli(argv, io) {
  if (argv[0] !== "no-confirmation") {
    const first = await io.confirm("FIRST_CONFIRM: ");
    if (first !== "DELETE") { io.stdout.write("CANCELLED\\n"); return 1; }
    const second = await io.confirm("SECOND_CONFIRM: ");
    if (second !== "DELETE") return 2;
  }
  io.stdout.write("COMMAND_COMPLETED\\n");
  return 0;
}\n`,
      );
      child = spawn(process.execPath, [join(root, "main.js"), mode], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: "production" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let first = false;
      let second = false;
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (!first && stdout.includes("FIRST_CONFIRM:")) {
          first = true;
          child.stdin.write(mode === "cancelled" ? "CANCEL\n" : "DELETE\n");
        }
        if (!second && stdout.includes("SECOND_CONFIRM:")) {
          second = true;
          child.stdin.write("DELETE\n");
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 2000);
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }).finally(() => clearTimeout(timer));
      assert.equal(timedOut, false, `completed command retained stdin; output=${stdout}`);
      assert.equal(result.code, mode === "cancelled" ? 1 : 0);
      assert.equal(result.signal, null);
      assert.equal(stderr, "");
      assert.ok(stdout.includes(mode === "cancelled" ? "CANCELLED" : "COMMAND_COMPLETED"));
      assert.equal(second, mode === "confirmed");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("close", resolve));
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
