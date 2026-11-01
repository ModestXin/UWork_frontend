import type { EnterpriseIdentityAuthority } from "./identityServiceLifecycle.js";
import type { IdentitySessionRecord } from "./identitySessionStore.js";
import { z } from "zod";

export const uworkSecuritySchema = z.object({
  allowShell: z.boolean(),
  allowFilesystem: z.boolean(),
  allowNetwork: z.boolean(),
  dangerousSkills: z.boolean(),
  allowedDomains: z.array(z.string().max(253)).max(200),
});

export interface UWorkBackendConfiguration {
  backend?: "uwork" | "ucas";
  apiBaseUrl: string;
  organizations?: { orgId: string }[];
}
export interface UWorkBackendSessionOptions {
  resolveConfig: () => Promise<UWorkBackendConfiguration | undefined>;
  readAuthority: () => EnterpriseIdentityAuthority | undefined;
  readPersistedSession: () => Promise<IdentitySessionRecord>;
  fetchImpl?: typeof fetch;
}
export interface UWorkBackendRequestOptions {
  /** 只允许后端签发的连接器会话标识；其他请求头由本端口独占，调用方不能覆盖。 */
  mcpSessionId?: string;
  method?: "GET" | "POST" | "DELETE";
  /** 该路径的额外等待上限；超过端口自身封顶即拒绝，不能无限放宽。 */
  timeoutMs?: number;
}
export interface UWorkBackendResponse {
  status: number;
  body: unknown;
  /** 仅回传后端签发的连接器会话标识，不暴露其他响应头。 */
  mcpSessionId?: string;
}
export interface UWorkBackendModelStream {
  readonly httpStatus: number;
  readonly contentType: "application/json" | "text/event-stream";
  read(): Promise<{ chunk: Uint8Array; done: boolean }>;
  close(): void;
}
export interface UWorkBackendScope {
  readonly ownerKey: string;
  readonly origin: string;
  readonly tenantId: string;
  readonly memberId: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): Promise<void>;
  /** 私有固定模型出口，不接受调用方鉴权头或任意路径。 */
  openModelStream?(body: string, signal: AbortSignal): Promise<UWorkBackendModelStream>;
  request(
    path: string,
    body?: unknown,
    options?: UWorkBackendRequestOptions,
  ): Promise<UWorkBackendResponse>;
}
export interface UWorkBackendSession {
  run<T>(
    operation: (scope: UWorkBackendScope) => Promise<T>,
    options?: { signal?: AbortSignal; traceId?: string },
  ): Promise<{ managed: false } | { managed: true; value: T }>;
}
export class UWorkBackendSessionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "UWorkBackendSessionError";
  }
}
