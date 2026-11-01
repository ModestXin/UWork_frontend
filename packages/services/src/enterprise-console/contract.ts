import {
  ServiceChannels,
  type EnterpriseAgent,
  type EnterpriseAssetMetadata,
  type EnterpriseMenu,
  type EnterpriseNavigation,
  type EnterpriseRun,
  type EnterpriseRunPage,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Base Host: current menu admission plus independently authorized compatibility APIs. */
export interface IEnterpriseConsoleService {
  getNavigation(): Promise<EnterpriseNavigation>;
  authorizeMenu(id: string): Promise<EnterpriseMenu>;
  listAgents(): Promise<EnterpriseAgent[]>;
  listAssets(): Promise<EnterpriseAssetMetadata[]>;
  listRuns(page: number): Promise<EnterpriseRunPage>;
  createRun(input: { agentId: string; input: string }): Promise<EnterpriseRun>;
  readRun(id: string): Promise<EnterpriseRun>;
  cancelRun(id: string): Promise<void>;
}
export const IEnterpriseConsoleService = createServiceDescriptor<IEnterpriseConsoleService>(
  ServiceChannels.EnterpriseConsole,
);
