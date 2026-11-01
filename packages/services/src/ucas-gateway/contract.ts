import type { Event } from "@zcode/rpc";
import {
  ServiceChannels,
  type UcasGatewaySyncResult,
  type UcasGatewayUsageRequest,
  type UcasGatewayView,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type {
  UcasGatewayEndpoint,
  UcasGatewayError,
  UcasGatewayKey,
  UcasGatewayModels,
  UcasGatewaySubscription,
  UcasGatewaySyncResult,
  UcasGatewayUsageMetric,
  UcasGatewayUsagePeriod,
  UcasGatewayUsageRequest,
  UcasGatewayUsageStats,
  UcasGatewayUser,
  UcasGatewayView,
} from "@zcode/shared";

/** 企业网关读取与自动配置；视图不含 JWT 与 API Key 明文。 */
export interface IUcasGatewayService {
  getView(): Promise<UcasGatewayView>;
  sync(reason: string): Promise<UcasGatewaySyncResult>;
  refreshUsage(request: UcasGatewayUsageRequest): Promise<UcasGatewayView>;
  refreshModels(): Promise<UcasGatewayView>;
  applyModels(): Promise<UcasGatewaySyncResult>;
  replaceApiKey(): Promise<UcasGatewaySyncResult>;
  onDidChange: Event<UcasGatewayView>;
}
export const IUcasGatewayService = createServiceDescriptor<IUcasGatewayService>(
  ServiceChannels.UcasGateway,
);

/** 自有后端授权目录的公开事实；只由Host私有Gateway写入对应精确模型规则。 */
export interface UWorkGatewayModelDescriptor {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsTools: boolean;
}

/** Node 装配注入的 Provider 写入端口；网关服务不直接依赖 Provider 实现。 */
export interface UcasGatewayProvisioningTarget {
  apply(input: {
    readonly baseUrl: string;
    /** Host私有撤销命令，不经string RPC；只清当前受管候选。 */
    readonly clearManagedCatalog?: true;
    readonly authMode?: "enterprise-session";
    /** 既有身份lease的只读准入检查，仅Host私有端口传递，不写盘。 */
    readonly isCurrent?: () => boolean;
    readonly apiKey?: string;
    readonly replaceApiKey?: boolean;
    readonly modelIds?: readonly string[];
    readonly managedModels?: readonly UWorkGatewayModelDescriptor[];
  }): Promise<{
    readonly apiKeyApplied: boolean;
    readonly hasApiKey: boolean;
    readonly modelsAdded: number;
    readonly modelsSkipped: number;
  }>;
  /** 读取 UCAS 供应商当前模型 ID，用于计算套餐模型的待追加数量。 */
  listModels(): Promise<readonly string[]>;
}
