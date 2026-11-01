import type { BrowserWindow } from "electron";
import type { ExternalWorkspaceOpenDialogCopy } from "./desktopOAuthDeepLink.js";
import {
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
  extractOpenWorkspacePathFromArgs,
  extractOpenWorkspacePathFromSingleInstanceData,
} from "./desktopDeepLinkUrl.js";

interface SecondInstanceWorkspaceDeps {
  additionalData: unknown;
  isRequestActive?: () => boolean;
  argv: readonly string[];
  handleDeepLink: (
    url: string,
    options: {
      confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  handleOpenWorkspacePath: (
    path: string,
    options?: {
      allowWithoutReadyWindow?: boolean;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  workspaceConfirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export function dispatchSecondInstanceWorkspaceRequest(
  deps: SecondInstanceWorkspaceDeps,
  onUnhandled: () => void,
): void {
  const request = { ...deps, argv: [...deps.argv] };
  // Electron 同步通知返回后才写单实例 ACK；原生确认阻塞该边界时，Linux 第二进程会误杀原实例。
  // 下一轮事件循环继续原校验/确认，不用任意延迟或绕过用户确认来掩盖握手问题。
  setImmediate(() => {
    if (request.isRequestActive && !request.isRequestActive()) return;
    if (!handleSecondInstanceWorkspaceRequest(request)) onUnhandled();
  });
}

export function handleSecondInstanceWorkspaceRequest(deps: SecondInstanceWorkspaceDeps): boolean {
  const url =
    // Linux 的 second-instance argv 可能被桌面环境重排或追加参数。
    // Electron 官方建议精确参数走 additionalData，这里优先读取第二实例预解析出的 deep link。
    extractDeepLinkUrlFromSingleInstanceData(deps.additionalData) ??
    extractDeepLinkUrlFromArgs(deps.argv);
  if (
    url &&
    deps.handleDeepLink(url, {
      confirmationCopy: deps.workspaceConfirmationCopy,
      resolveApplicationWindow: deps.resolveApplicationWindow,
    })
  ) {
    return true;
  }

  const openWorkspacePath =
    extractOpenWorkspacePathFromSingleInstanceData(deps.additionalData) ??
    extractOpenWorkspacePathFromArgs(deps.argv);
  return Boolean(
    openWorkspacePath &&
    deps.handleOpenWorkspacePath(openWorkspacePath, {
      resolveApplicationWindow: deps.resolveApplicationWindow,
    }),
  );
}
