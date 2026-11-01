import type { EnterpriseConnectorReference } from "@zcode/shared";
import type { TraceContext } from "../tracing/tracer.js";

/** 一次连接器 MCP 帧往返：帧内容与结果都由 Host 侧后端代理决定。 */
export interface EnterpriseConnectorRequest {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 目录中当前的不可变绑定；Host 在每次往返前重新准入。 */
  connector: EnterpriseConnectorReference;
  /** 目录 ownerKey，绑定当前私有配置代次；缺失即拒绝。 */
  ownerKey: string;
  /** 单条 JSON-RPC 帧（initialize/tools/list/tools/call/通知）。 */
  frame: unknown;
  /** 后端签发的连接器会话标识；由 Host 逐连接持有并回传。 */
  mcpSessionId?: string;
  traceContext: TraceContext;
}

export type EnterpriseConnectorResult =
  | { status: "ok"; frame?: unknown; mcpSessionId?: string }
  | { status: "denied"; code: string };

export interface EnterpriseConnectorReleaseRequest {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  connector: EnterpriseConnectorReference;
  ownerKey: string;
  mcpSessionId: string;
  traceContext: TraceContext;
}

/**
 * 连接器的唯一出口。CLI 不持有后端凭据、远端地址或远端会话，
 * 所有 MCP 帧都经现有反向 RPC 交给 Host 的私有后端会话代理。
 */
export interface EnterpriseConnectorPort {
  request(
    input: EnterpriseConnectorRequest,
    signal?: AbortSignal,
  ): Promise<EnterpriseConnectorResult>;
  /** 释放后端签发的连接器会话；失败不阻断本地清理，只记录稳定错误码。 */
  release(
    input: EnterpriseConnectorReleaseRequest,
    signal?: AbortSignal,
  ): Promise<EnterpriseConnectorResult>;
}
