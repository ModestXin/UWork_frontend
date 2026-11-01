// Test-only AST projection: keep actual production callback bodies/dependencies.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import ts from "typescript";

export async function extractNavigationCallbacks(clientRoot) {
  const provenance = [];
  async function parsed(relative) {
    const raw = await readFile(join(clientRoot, relative), "utf8");
    const file = ts.createSourceFile(
      relative,
      raw,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    return { raw, file, relative };
  }
  function record(source, node, symbol) {
    const text = node.getText(source.file);
    provenance.push({
      source: source.relative,
      sourceSha256: createHash("sha256").update(source.raw).digest("hex"),
      symbol,
      start: node.getStart(source.file),
      end: node.end,
      originalText: text,
      extractedSha256: createHash("sha256").update(text).digest("hex"),
    });
    return text;
  }
  function callback(source, symbol) {
    const matches = [];
    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === symbol
      ) {
        assert.ok(node.initializer && ts.isCallExpression(node.initializer));
        assert.equal(node.initializer.expression.getText(source.file), "useCallback");
        matches.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    }
    visit(source.file);
    assert.equal(matches.length, 1, "Exactly one actual production callback: " + symbol);
    return record(source, matches[0], symbol);
  }
  const app = await parsed("packages/ui/src/App.tsx");
  const task = await parsed("packages/ui/src/app-shell/useWorkspaceTaskNavigation.ts");
  const settings = await parsed("packages/ui/src/SettingsPage.tsx");
  const expressions = {
    useActualExit: callback(app, "handleNavigateToTaskMain"),
    useActualNavigate: callback(app, "handleNavigateToPluginStoreMain"),
    useActualTaskOpen: callback(task, "handleOpenPluginStore"),
    useActualScopeOpen: callback(app, "handleOpenPluginStoreForScope"),
  };
  const settingsMatches = [];
  function settingsVisit(node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(settings.file) === "PluginsSection"
    ) {
      const attrs = node.attributes.properties;
      const actualPlugin = attrs.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(settings.file) === "initialTab" &&
          attribute.initializer &&
          ts.isJsxExpression(attribute.initializer) &&
          attribute.initializer.expression?.getText(settings.file) === "pluginTab",
      );
      if (actualPlugin) {
        const attr = attrs.find(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(settings.file) === "onOpenPluginStore",
        );
        assert.ok(attr?.initializer && ts.isJsxExpression(attr.initializer));
        assert.ok(attr.initializer.expression && ts.isArrowFunction(attr.initializer.expression));
        settingsMatches.push(attr.initializer.expression);
      }
    }
    ts.forEachChild(node, settingsVisit);
  }
  settingsVisit(settings.file);
  assert.equal(settingsMatches.length, 1, "Actual plugin Settings browse callback");
  expressions.actualSettingsBrowse = record(
    settings,
    settingsMatches[0],
    "PluginsSection.onOpenPluginStore",
  );
  const bindings =
    "useCallback,workspaceMainView,setWorkspaceMainView,setPluginStoreReturnScopeKey,setPluginStoreOpenVersion,preserveNextSettingsExit,handleOpenPluginStore,taskNavPushPluginStore,workspaceAbsPath,workspaceIdentity,onNavigateToPluginStore,requestPluginStoreOpen,onBack";
  const code = Object.entries(expressions)
    .map(
      ([name, expression]) =>
        `export function ${name}(context){const {${bindings}}=context;return (${expression});}`,
    )
    .join("\n");
  const transpiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return {
    code: transpiled,
    provenance,
    extraction:
      "actual AST nodes including useCallback dependency arrays; no equivalent-logic rewrite",
  };
}
