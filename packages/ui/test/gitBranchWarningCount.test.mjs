import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const path = new URL("../src/git-branch-switcher/GitBranchDialogs.tsx", import.meta.url);
const source = ts.createSourceFile(
  path.pathname,
  readFileSync(path, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const branches = new Map();
function visit(node) {
  if (ts.isConditionalExpression(node)) {
    const condition = node.condition.getText(source);
    for (const step of ["blocked", "commit"]) {
      if (condition === `step === "${step}" && state`) {
        assert.equal(branches.has(step), false);
        branches.set(
          step,
          ts.transpileModule("return (" + node.whenTrue.getText(source) + ");", {
            compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
          }).outputText,
        );
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.deepEqual([...branches.keys()], ["blocked", "commit"]);
const slot = ({ children }) => React.createElement("div", null, children);
const button = ({ children, disabled }) => React.createElement("button", { disabled }, children);
const file = (path) => ({
  workspaceRelativePath: path,
  repoRelativePath: path,
  added: 1,
  removed: 1,
});
function render(step, affectedCount, totalCount) {
  const state = {
    issue: { code: "local-changes-would-be-overwritten" },
    affectedFiles: Array.from({ length: affectedCount }, (_, i) => file(`affected-${i}.txt`)),
    fileCount: totalCount,
    totalAdded: totalCount,
    totalRemoved: totalCount,
    targetBranchName: "owned-target",
  };
  const values = {
    React,
    state,
    numberFormatter: new Intl.NumberFormat("en-US"),
    intl: {
      formatMessage: ({ id }, values) =>
        values?.count !== undefined ? `FILECOUNT:${values.count}` : id,
    },
    mutationPending: false,
    onClose: () => {},
    onOpenCommit: () => {},
    onSubmit: () => {},
    onCommitMessageChange: () => {},
    descriptionId: "description",
    currentBranchLabel: "main",
    hasIdentity: true,
    commitMessage: "message",
    commitError: null,
    DialogContent: slot,
    DialogHeader: slot,
    DialogTitle: slot,
    DialogDescription: slot,
    DialogFooter: slot,
    Button: button,
    Textarea: () => null,
    FileDisplayInline: ({ path }) => React.createElement("code", null, path),
    AlertCircleIcon: () => null,
    GitBranchIcon: () => null,
    LoaderIcon: () => null,
  };
  return renderToStaticMarkup(
    new Function(...Object.keys(values), branches.get(step))(...Object.values(values)),
  );
}
for (const [affected, total] of [
  [1, 2],
  [2, 3],
]) {
  test(`actual overwrite warning counts its ${affected} listed files instead of all ${total} pending changes`, () => {
    const html = render("blocked", affected, total);
    assert.ok(html.includes(`FILECOUNT:${affected}`));
    assert.equal((html.match(/<code>/g) ?? []).length, affected);
    assert.equal(html.includes(`FILECOUNT:${total}`), false);
  });
}
test("actual commit preview still reports all pending changes", () => {
  const html = render("commit", 1, 3);
  assert.ok(html.includes("FILECOUNT:3"));
  assert.equal(html.includes("FILECOUNT:1"), false);
});
