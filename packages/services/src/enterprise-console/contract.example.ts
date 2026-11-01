import type { IEnterpriseConsoleService } from "./contract.js";
export async function readVisibleEnterpriseAgents(console: IEnterpriseConsoleService) {
  return console.listAgents();
}
