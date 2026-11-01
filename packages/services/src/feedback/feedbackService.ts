import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import type { ApiClient, FeedbackDeviceInfo, UWorkClientPresentation } from "@zcode/shared";
import {
  buildRuntimeZCodeApiUrl,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_VERSION,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { ICredentialService } from "../credential/credential.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import { FeedbackHttpClient, FeedbackUploadCanceledError } from "./feedbackHttpClient.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { getFeedbackAttachmentDir } from "../paths.js";
import { FeedbackLocalTicketStore } from "#src/feedback/feedbackLocalTicketStore.js";
import type { EnterpriseIdentityAuthority } from "../enterprise-identity/identityServiceLifecycle.js";

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

export interface CreateFeedbackServiceOptions {
  credentialService: ICredentialService;
  oauthService: IOAuthService;
  apiClient: ApiClient;
  getDeviceMid?: () => string | undefined;
  apiBaseUrl?: string;
  createFullLogArchive?: (
    sourceDir: string,
    options?: {
      onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
    },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
  /** Existing private identity projection; managed feedback never uses the legacy ticket backend. */
  readClientPresentation?: () => Promise<UWorkClientPresentation>;
  /** Same Node identity owner; a per-operation receipt must survive even unmanaged-to-unmanaged changes. */
  readIdentityAuthority?: () =>
    | Pick<EnterpriseIdentityAuthority, "generation" | "revision" | "signal">
    | undefined;
}

function resolveApiBaseUrl(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.ZCODE_FEEDBACK_API_BASE?.trim() ||
    buildRuntimeZCodeApiUrl(process.env, "/api/v1")
  );
}

function buildDeviceSnapshot(): FeedbackDeviceInfo {
  return {
    appVersion: ZCODE_VERSION,
    buildCommitId: ZCODE_COMMIT,
    buildTime: ZCODE_BUILD_TIME,
    nodeVersion: process.version,
    osType: osType(),
    osPlatform: platform(),
    osRelease: release(),
    // node:os.version() 在 macOS 上是完整 Darwin kernel 字符串，超过后端 os_version VARCHAR(64) 会写库失败。
    osVersion: release(),
    osArch: arch(),
  };
}

export function createFeedbackService(options: CreateFeedbackServiceOptions): IFeedbackService {
  const apiBaseUrl = resolveApiBaseUrl(options.apiBaseUrl);
  const assertLegacyFeedbackAllowed = async () => {
    if (!options.readClientPresentation) return;
    const view = await options.readClientPresentation();
    if (view.status === "unmanaged") return;
    if (view.status !== "ready" || view.help.status !== "ready")
      throw new Error("enterprise_feedback_unavailable");
    throw new Error(
      view.help.data.feedback.mode === "external"
        ? "enterprise_feedback_external_only"
        : "enterprise_feedback_disabled",
    );
  };
  function getHostDeviceMid(): string | undefined {
    return options.getDeviceMid?.()?.trim() || undefined;
  }

  function requireHostDeviceMid(): string {
    const deviceMid = getHostDeviceMid();
    if (!deviceMid) {
      throw new Error("Missing feedback device_mid");
    }
    return deviceMid;
  }

  async function getZcodeJwtToken(): Promise<string | undefined> {
    return (await options.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() || undefined;
  }

  async function hasZcodeJwtToken(): Promise<boolean> {
    return Boolean(await getZcodeJwtToken());
  }

  const getAuthHeaders = async () => {
    const headers: Record<string, string> = {};
    const deviceMid = getHostDeviceMid();
    // feedback 的 device_mid 必须复用宿主 deviceMid（与 provider 请求头、远控同一身份）；
    // 不单独生成 fb_ 身份，否则同一台机器在不同系统里会被拆成两个设备。
    if (deviceMid) {
      headers["X-Device-Mid"] = deviceMid;
    }
    const jwtToken = await getZcodeJwtToken();
    if (jwtToken) {
      headers.Authorization = `Bearer ${jwtToken}`;
    }
    return headers;
  };
  function createFeedbackOperation(callerSignal?: AbortSignal) {
    const before = options.readIdentityAuthority?.();
    const assertCurrent = () => {
      if (options.readIdentityAuthority) {
        const current = options.readIdentityAuthority();
        if (
          !before ||
          !current ||
          before.generation !== current.generation ||
          before.revision !== current.revision ||
          before.signal !== current.signal ||
          before.signal.aborted
        )
          throw new Error("enterprise_identity_changed");
      }
      callerSignal?.throwIfAborted();
    };
    assertCurrent();
    const signal = before
      ? callerSignal
        ? AbortSignal.any([before.signal, callerSignal])
        : before.signal
      : callerSignal;
    const assertAllowed = async () => {
      // 当前 mode 不是旧操作的收据；前后都 unmanaged 时仍必须属于原 generation。
      assertCurrent();
      await assertLegacyFeedbackAllowed();
      assertCurrent();
    };
    const httpClient = new FeedbackHttpClient({
      baseUrl: apiBaseUrl,
      apiClient: options.apiClient,
      getAuthHeaders,
      signal,
      assertLegacyFeedbackAllowed: assertAllowed,
    });
    return { httpClient, signal, assertAllowed, assertCurrent };
  }
  async function withFeedbackOperation<T>(
    perform: (operation: ReturnType<typeof createFeedbackOperation>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const operation = createFeedbackOperation(signal);
    try {
      await operation.assertAllowed();
      const result = await perform(operation);
      await operation.assertAllowed();
      return result;
    } catch (error) {
      operation.assertCurrent();
      throw error;
    }
  }
  const localTicketStore = new FeedbackLocalTicketStore();
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();
  const activeUploadControllers = new Map<string, AbortController>();
  const activeCreateControllers = new Map<string, AbortController>();

  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  return {
    create: async (input, createOptions) => {
      const device = input.device ?? buildDeviceSnapshot();
      const operationId = createOptions?.operationId?.trim();
      const controller = new AbortController();
      if (operationId) {
        // UI 取消创建工单时不能只关闭弹窗；host 需要能按 operationId
        // 找到当前 HTTP 请求并 abort，避免“正在连接反馈服务”永久悬挂。
        activeCreateControllers.get(operationId)?.abort();
        activeCreateControllers.set(operationId, controller);
      }
      try {
        // 必须先登记原取消 owner 再等私有配置，否则等待期间的 cancelCreate 会丢失。
        return await withFeedbackOperation(async (operation) => {
          const ticket = await operation.httpClient.create(
            {
              ...input,
              device,
            },
            {
              signal: operation.signal,
            },
          );
          const authenticated = await hasZcodeJwtToken();
          await operation.assertAllowed();
          if (!authenticated) {
            await localTicketStore.upsert(requireHostDeviceMid(), ticket, operation.assertCurrent);
          }
          return ticket;
        }, controller.signal);
      } finally {
        if (operationId && activeCreateControllers.get(operationId) === controller) {
          activeCreateControllers.delete(operationId);
        }
      }
    },
    cancelCreate: async (operationId) => {
      const key = operationId.trim();
      if (!key) return;
      activeCreateControllers.get(key)?.abort();
    },
    list: async (query) =>
      withFeedbackOperation(async (operation) => {
        if (await hasZcodeJwtToken()) {
          return operation.httpClient.list(query);
        }
        const items = await localTicketStore.list(requireHostDeviceMid(), query);
        return { items, total: items.length };
      }),
    get: async (id) => withFeedbackOperation((operation) => operation.httpClient.get(id)),
    comment: async (id, body) =>
      withFeedbackOperation((operation) => operation.httpClient.comment(id, body)),
    uploadAttachment: async (id, kind, file) =>
      withFeedbackOperation(async (operation) => {
        const filename = file.filename ?? basename(file.path);
        const contentType =
          file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
        return operation.httpClient.uploadFile(id, kind, file.path, filename, contentType, {
          messageId: file.messageId,
          signal: operation.signal,
        });
      }),
    uploadAttachmentWithProgress: async (id, kind, file, progressId) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      const emitter = getUploadProgressEmitter(progressId);
      emitter.fire({
        id: progressId,
        phase: "preparing",
        uploadedBytes: 0,
        totalBytes: 0,
      });
      const controller = new AbortController();
      activeUploadControllers.set(progressId, controller);
      try {
        return await withFeedbackOperation(
          (operation) =>
            operation.httpClient.uploadFile(id, kind, file.path, filename, contentType, {
              messageId: file.messageId,
              signal: operation.signal,
              onUploadProgress: (event) => {
                emitter.fire({
                  id: progressId,
                  phase: event.uploadedBytes >= event.totalBytes ? "complete" : "uploading",
                  uploadedBytes: event.uploadedBytes,
                  totalBytes: event.totalBytes,
                });
              },
            }),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof FeedbackUploadCanceledError || controller.signal.aborted) {
          emitter.fire({
            id: progressId,
            phase: "canceled",
            uploadedBytes: 0,
            totalBytes: 0,
          });
        }
        throw error;
      } finally {
        if (activeUploadControllers.get(progressId) === controller)
          activeUploadControllers.delete(progressId);
      }
    },
    cancelUpload: async (progressId) => {
      activeUploadControllers.get(progressId)?.abort();
    },
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
    uploadAttachmentData: async (id, kind, file) =>
      withFeedbackOperation(async (operation) => {
        const attachmentRootDir = getFeedbackAttachmentDir();
        await mkdir(attachmentRootDir, { recursive: true });
        const tempDir = await mkdtemp(join(attachmentRootDir, "attachment-"));
        // 附件名来自 renderer，不能作为本地相对路径使用。
        const filename = basename(file.filename.replaceAll("\\", "/")) || "attachment";
        const tempPath = join(tempDir, "content");
        try {
          await writeFile(tempPath, Buffer.from(file.dataBase64, "base64"));
          return await operation.httpClient.uploadFile(
            id,
            kind,
            tempPath,
            filename,
            file.contentType,
            {
              messageId: file.messageId,
              signal: operation.signal,
            },
          );
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      }),
    attachLogsFromExport: async (id, attachOptions) =>
      withFeedbackOperation(async (operation) => {
        const archive = await prepareCompactLogArchive({
          full: attachOptions?.full,
          createFullArchive: options.createFullLogArchive,
        });
        try {
          return await operation.httpClient.uploadFile(
            id,
            "log",
            archive.path,
            basename(archive.path),
            "application/zip",
            { signal: operation.signal },
          );
        } finally {
          await cleanupLogArchive(archive.path);
        }
      }),
    getDeviceSnapshot: async () => buildDeviceSnapshot(),
    prepareCompactLogArchive: async (archiveOptions) => {
      const progressId = archiveOptions?.progressId;
      const progressEmitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: progressEmitter
          ? (event) => {
              progressEmitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              });
            }
          : undefined,
      });
    },
    cleanupPreparedLogArchive: (path) => cleanupLogArchive(path),
    revealLogArchive: async (path) => {
      if (options.revealPath) {
        await options.revealPath(path);
        return;
      }
    },
  };
}
