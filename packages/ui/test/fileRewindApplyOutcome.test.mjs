import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const path = new URL("../src/v4/ConversationFileSummaryPanel.tsx", import.meta.url);
const text = readFileSync(path, "utf8");
const source = ts.createSourceFile(
  path.pathname,
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const handlers = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleApply") {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    handlers.push(node.initializer.arguments[0].getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(
  handlers.length,
  1,
  "execute the original component callback, not a parallel implementation",
);
const callbackJs = ts.transpileModule("return (" + handlers[0] + ");", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const safe = {
  canApply: true,
  safeFiles: [{ path: "owned.txt", operationCount: 1 }],
  unsafeFiles: [],
  ignoredFiles: [],
};
const unsafe = {
  canApply: false,
  safeFiles: [],
  unsafeFiles: [{ path: "owned.txt", reason: "external_modified" }],
  ignoredFiles: [],
};
const fallback = "localized:chat.changeSummary.rewindDialog.error";
function fixture(reply) {
  const state = { dialog: true, applying: false, error: null, preview: safe, calls: 0 };
  const values = {
    context: {
      applyFileRewind: async () => {
        state.calls++;
        return await reply();
      },
    },
    target: { rowId: 1, entityId: "turn-1" },
    preview: safe,
    setApplying: (value) => {
      state.applying = value;
    },
    setError: (value) => {
      state.error = value;
    },
    setDialogOpen: (value) => {
      state.dialog = value;
    },
    setPreview: (value) => {
      state.preview = value;
    },
    intl: { formatMessage: ({ id }) => "localized:" + id },
  };
  const run = new Function(...Object.keys(values), callbackJs)(...Object.values(values));
  assert.equal(typeof run, "function", "original async callback must be executable");
  return { state, run };
}

for (const status of ["accepted", "duplicate"]) {
  test(status + " failed apply keeps the dialog and latest unsafe preview", async () => {
    const f = fixture(async () => ({
      status,
      result: { type: "applyFileRewind", applied: false, preview: unsafe },
    }));
    await f.run();
    assert.equal(f.state.dialog, true);
    assert.deepEqual(f.state.preview, unsafe);
    assert.equal(f.state.error, fallback);
    assert.equal(f.state.applying, false);
    assert.equal(f.state.calls, 1);
  });
  test(status + " actual applied result closes the dialog", async () => {
    const f = fixture(async () => ({
      status,
      result: { type: "applyFileRewind", applied: true, preview: safe },
    }));
    await f.run();
    assert.equal(f.state.dialog, false);
    assert.equal(f.state.error, null);
    assert.equal(f.state.applying, false);
  });
}
test("accepted without the expected result cannot report success", async () => {
  const f = fixture(async () => ({ status: "accepted" }));
  await f.run();
  assert.equal(f.state.dialog, true);
  assert.equal(f.state.error, fallback);
});
test("pending and rejected applications never close or auto-retry", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(() => pending);
  const task = f.run();
  assert.equal(f.state.applying, true);
  assert.equal(f.state.dialog, true);
  finish({ status: "rejected", message: "Owned rejection" });
  await task;
  assert.equal(f.state.error, "Owned rejection");
  assert.equal(f.state.dialog, true);
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.applying, false);
});
test("transport failure retains the dialog and releases applying", async () => {
  const f = fixture(async () => {
    throw new Error("owned transport failure");
  });
  await f.run();
  assert.equal(f.state.dialog, true);
  assert.equal(f.state.error, fallback);
  assert.equal(f.state.applying, false);
});
