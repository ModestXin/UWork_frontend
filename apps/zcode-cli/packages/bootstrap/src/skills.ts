import { resolve } from "node:path";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import type {
  Logger,
  SkillContent,
  SkillDiagnostic,
  SkillLoadOutcome,
  SkillPort,
  TraceContext,
  EnterpriseSkillsCatalogPort,
  EnterpriseToolAuthorizationPort,
} from "@zcode/contracts";
import { createRootTraceContext } from "@zcode/contracts";
import { resolveBundledSkillRoots } from "./app/bundled-skills.js";
import { getCliStorageRoot } from "./app/paths.js";
import { filterVisualizeSkillRoots } from "./app/visualize-skill-gate.js";
import { createConfiguredSkillPort } from "./skill-runtime.js";
import { resolveZCodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";

export interface ListZCodeSkillsOptions {
  env?: NodeJS.ProcessEnv;
  /** 协议宿主草稿目录使用；CLI 命令缺省关闭。 */
  includeVisualize?: boolean;
  logger?: Logger;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
  enterpriseSkillsCatalog?: EnterpriseSkillsCatalogPort;
  enterpriseToolAuthorization?: EnterpriseToolAuthorizationPort;
  traceContext?: TraceContext;
  sessionId?: string;
  workspaceIdentity?: string;
}

export interface InspectZCodeSkillOptions extends ListZCodeSkillsOptions {
  name: string;
}

export interface ZCodeSkillInspection {
  diagnostics: SkillDiagnostic[];
  skill: SkillContent;
}

export async function listZCodeSkills(
  options: ListZCodeSkillsOptions = {},
): Promise<SkillLoadOutcome> {
  const discovery = createSkillDiscovery(options);
  if (!discovery.enabled) {
    return {
      diagnostics: [],
      skills: [],
      totalDiscovered: 0,
    };
  }

  return await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
    trace: options.traceContext,
  });
}

export async function inspectZCodeSkill(
  options: InspectZCodeSkillOptions,
): Promise<ZCodeSkillInspection> {
  const discovery = createSkillDiscovery(options);
  if (!discovery.enabled) {
    throw new Error("Skills are disabled.");
  }

  const outcome = await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
    trace: options.traceContext,
  });
  if (
    !outcome.skills.some(
      (skill) => skill.name === options.name || skill.qualifiedName === options.name,
    )
  ) {
    throw new Error(`Skill not found: ${options.name}`);
  }

  const skill = await discovery.skillPort.loadSkill({
    name: options.name,
    workingDirectory: discovery.workingDirectory,
    trace: options.traceContext,
  });

  return {
    diagnostics: outcome.diagnostics,
    skill,
  };
}

function createSkillDiscovery(options: ListZCodeSkillsOptions):
  | {
      enabled: false;
      workingDirectory: string;
    }
  | {
      enabled: true;
      skillPort: SkillPort;
      workingDirectory: string;
    } {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult = createConfig({
    env: options.env,
    projectConfigPath: options.projectConfigPath,
    workingDirectory,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
  });

  if (!configResult.config.features.skill || !configResult.config.skills.enabled) {
    return {
      enabled: false,
      workingDirectory,
    };
  }
  const pluginOutcome = resolveZCodePlugins({
    configResult,
    env: options.env,
    logger: options.logger,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory,
  });

  // 内置技能包与插件技能根并列注入：`zcode skills list`、引用目录与 runtime 看到同一份发现结果。
  const bundledSkillRoots = resolveBundledSkillRoots({
    cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
    logger: options.logger,
  });

  return {
    enabled: true,
    skillPort: createConfiguredSkillPort({
      enabled: true,
      roots: configResult.config.skills.roots,
      resolvedRoots: [
        ...filterVisualizeSkillRoots(pluginOutcome.skillRoots, options.includeVisualize),
        ...bundledSkillRoots,
      ],
      disabledPaths: collectDisabledPaths(configResult.config.skillOverrides),
      context: {
        authorization: options.enterpriseToolAuthorization,
        catalog: options.enterpriseSkillsCatalog,
        sessionId: options.sessionId ?? "enterprise-draft",
        workspacePath: workingDirectory,
        workspaceIdentity: options.workspaceIdentity,
        traceContext: options.traceContext ?? createRootTraceContext(),
      },
    })!,
    workingDirectory,
  };
}
