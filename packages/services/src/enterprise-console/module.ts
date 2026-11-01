export const enterpriseConsoleModule = {
  id: "enterprise-console",
  requires: ["shared", "services"],
  provides: ["enterprise-console"],
  publicEntrypoints: ["contract.ts"],
} as const;
export { createEnterpriseConsoleService } from "./app/service.js";
