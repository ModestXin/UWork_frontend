import { join } from "node:path";
import { UWORK_DATA_ROOT_DIR_NAME } from "@zcode/shared";
import type { ServerLayout } from "./paths.js";

/** 默认用户目录只属于当前 Server profile，不改 Supervisor 的环境。 */
export function createServerCoreProfileEnvironment(
  layout: Pick<ServerLayout, "dataBaseDir" | "serverRoot">,
): Record<string, string> {
  return {
    HOME: layout.dataBaseDir,
    USERPROFILE: layout.dataBaseDir,
    ZCODE_DESKTOP_HOME_DIR: layout.dataBaseDir,
    UWORK_DATA_BASE_DIR: layout.dataBaseDir,
    ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
    ZCODE_STORAGE_DIR: join(layout.dataBaseDir, UWORK_DATA_ROOT_DIR_NAME),
    ZCODE_SERVER_ROOT: layout.serverRoot,
  };
}
