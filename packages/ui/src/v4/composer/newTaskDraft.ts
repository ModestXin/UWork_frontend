import type { ComposerInitialConfig } from "@/store/zcodeSessionStoreTypes.js";
import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type ComposerScope,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  scope?: ComposerScope,
): V4ComposerDraft {
  if (draft.mode) {
    if (draft.initializeFromNewTask !== true) return draft;
    // 空身份首读可先初始化模式；目录晚到只补首个模型，不能覆盖期间编辑的正文或权限。
    const modelSelection =
      draft.modelSelection ?? resolveDraftInitialModelSelection(view, null).selection;
    return modelSelection ? { ...draft, initializeFromNewTask: undefined, modelSelection } : draft;
  }
  const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, scope);
  const modelSelection =
    draft.modelSelection ??
    recent?.modelSelection ??
    resolveDraftInitialModelSelection(view, null).selection ??
    undefined;
  return {
    ...draft,
    // 模式就绪不代表用户已决定模型；原草稿保留初始化资格，直到取得首个合法默认。
    ...(modelSelection ? {} : { initializeFromNewTask: true as const }),
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection,
  };
}

/** 首次导入由导航动作显式传参；复用历史或已有文字草稿不覆盖。 */
export function resolveImportedComposerConfig(
  result: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    reused: boolean;
  },
  clientNamespace = "desktop",
): ComposerInitialConfig | undefined {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return undefined;
  const scope =
    readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace) ??
    resolveComposerScope(null, workspaceIdentity, clientNamespace);
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  return root?.mode
    ? {
        mode: root.mode,
        planEnabled: root.planEnabled ?? false,
        modelSelection: root.modelSelection,
      }
    : {};
}
