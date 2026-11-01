import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import type { AgentPermissionMode } from "./subagents-types.js";

export type AgentProfileSource = "built-in" | "project" | "user" | "enterprise";
export type AgentMemoryScope = "user" | "project" | "local";

export interface AgentProfile {
  /** 受管来源限定选择名不参与模糊别名匹配，避免旧企业名字变成个人选择。 */
  exactSelection?: boolean;
  background?: boolean;
  color?: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
  description: string;
  disallowedTools?: readonly string[];
  injectAgentsMd?: boolean;
  maxTurns?: number;
  mcpServers?: readonly string[];
  memory?: AgentMemoryScope;
  modelSelection?: ModelSelection;
  name: string;
  path?: string;
  permissionMode?: AgentPermissionMode;
  skills?: readonly string[];
  source: AgentProfileSource;
  systemPrompt: string;
  tools?: readonly string[];
}

export interface AgentProfileParseDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentProfileLoadResult {
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

/** 完整运行时 profile 的跨进程边界，不使用 Settings 摘要代替。 */
export const agentProfileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    source: z.enum(["built-in", "project", "user", "enterprise"]),
    exactSelection: z.boolean().optional(),
    systemPrompt: z.string(),
    path: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    background: z.boolean().optional(),
    injectAgentsMd: z.boolean().optional(),
    color: z
      .enum(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"])
      .optional(),
    permissionMode: z
      .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
      .optional(),
    memory: z.enum(["user", "project", "local"]).optional(),
    maxTurns: z.number().int().positive().optional(),
    tools: z.array(z.string()).readonly().optional(),
    disallowedTools: z.array(z.string()).readonly().optional(),
    skills: z.array(z.string()).readonly().optional(),
    mcpServers: z.array(z.string()).readonly().optional(),
  })
  .strict();
