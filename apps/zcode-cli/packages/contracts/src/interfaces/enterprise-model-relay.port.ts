import type {
  ZCodeEnterpriseModelRequestParams,
  ZCodeEnterpriseModelRequestResult,
} from "@zcode/shared";
import type { TraceContext } from "../tracing/tracer.js";

/** 私有Host模型传输；不承载Token、Key、Header或另一份身份状态。 */
export interface EnterpriseModelRelayRequest {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  traceContext: TraceContext;
  request: ZCodeEnterpriseModelRequestParams["request"];
}
export interface EnterpriseModelRelayPort {
  request(
    input: EnterpriseModelRelayRequest,
    signal?: AbortSignal,
  ): Promise<ZCodeEnterpriseModelRequestResult>;
}
