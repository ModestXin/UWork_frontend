import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useWorkspaceMainViewSettingsExit } from "@/app-shell/useWorkspaceMainViewSettingsExit.js";
import type { WorkspaceMainView } from "@/app-shell/types.js";
import { addPluginStoreOpenListener, requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import {
  actualSettingsBrowse,
  useActualExit,
  useActualNavigate,
  useActualScopeOpen,
  useActualTaskOpen,
} from "virtual:actual-plugin-navigation";

let runtimeErrors = 0;
window.addEventListener("error", () => runtimeErrors++);
window.addEventListener("unhandledrejection", () => runtimeErrors++);

// Only input/setter/navigation ports are fixture-owned. All decisions under test
// are actual App callbacks plus the actual production settings-exit hook.
function Fixture() {
  const [workspaceMainView, setWorkspaceMainView] = useState<WorkspaceMainView>("chat");
  const [isWorkspaceVisible, setWorkspaceVisible] = useState(true);
  const [returnScope, setPluginStoreReturnScopeKey] = useState("user");
  const [openVersion, setPluginStoreOpenVersion] = useState(0);
  const [routePushes, setRoutePushes] = useState(0);
  const [ready, setReady] = useState(false);
  const handleNavigateToTaskMain = useActualExit({ useCallback, setWorkspaceMainView });
  const { preserveNextSettingsExit } = useWorkspaceMainViewSettingsExit({
    isWorkspaceVisible,
    workspaceMainView,
    onExitSettings: handleNavigateToTaskMain,
  });
  const navigate = useActualNavigate({
    useCallback,
    setWorkspaceMainView,
    setPluginStoreReturnScopeKey,
    setPluginStoreOpenVersion,
    preserveNextSettingsExit,
  });
  const taskNavPushPluginStore = useCallback(() => setRoutePushes((n) => n + 1), []);
  const handleOpenPluginStore = useActualTaskOpen({
    useCallback,
    taskNavPushPluginStore,
    workspaceAbsPath: "/owned/navigation-case",
    workspaceIdentity: undefined,
    onNavigateToPluginStore: navigate,
  });
  const scopeOpen = useActualScopeOpen({
    useCallback,
    workspaceMainView,
    setPluginStoreReturnScopeKey,
    setPluginStoreOpenVersion,
    preserveNextSettingsExit,
    handleOpenPluginStore,
  });
  useEffect(() => addPluginStoreOpenListener(scopeOpen), [scopeOpen]);
  useEffect(() => {
    setReady(true);
  }, []);
  const onBack = useCallback(() => setWorkspaceVisible(true), []);
  const browse = actualSettingsBrowse({ requestPluginStoreOpen, onBack });
  const facts = {
    ready,
    workspaceMainView,
    isWorkspaceVisible,
    returnScope,
    openVersion,
    routePushes,
    runtimeErrors,
  };
  return (
    <main>
      <h1>Owned plugin navigation component regression</h1>
      {isWorkspaceVisible ? (
        <section data-testid="workspace-surface">
          <p data-testid="actual-main-view">{workspaceMainView}</p>
          <button onClick={handleOpenPluginStore}>Open store</button>
          <button onClick={() => setWorkspaceVisible(false)}>Open settings</button>
        </section>
      ) : (
        <section data-testid="settings-surface">
          <button onClick={() => browse("user")}>Browse plugins</button>
          <button onClick={onBack}>Back</button>
        </section>
      )}
      <output data-testid="navigation-facts">{JSON.stringify(facts)}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
