import { join } from "node:path";
import type { TraceContext } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { formatProjectMemoryIndexContent } from "../../memory/index-content.js";
import {
  createReadFileStateKey,
  normalizeReadFileStateMtimeMs,
} from "../../tool/read-file-state.js";
import {
  authorizeProjectMemoryIndex,
  createPromptAttachmentAuthorizationContext,
  PromptAttachmentAuthorizationError,
  waitForAttachment,
} from "./attachment-authorization.js";

export interface PendingProjectMemoryIndex {
  authorizeCommit: () => Promise<() => string | undefined>;
}

/** 新 index 先只保留在操作内；最后一个 context await 后才允许同步提交。 */
export async function prepareProjectMemoryIndex(
  runtime: AgentRuntimeInternal,
  memoryRoot: string | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<PendingProjectMemoryIndex | undefined> {
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort || !memoryRoot) return undefined;
  const indexPath = join(memoryRoot, "MEMORY.md");
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (
      runtime.shuttingDown ||
      runtime.fileSystemPort !== fileSystemPort ||
      runtime.memoryRoot !== memoryRoot
    )
      throw new PromptAttachmentAuthorizationError("enterprise_execution_context_changed");
  };
  let admission: Awaited<ReturnType<typeof authorizeProjectMemoryIndex>>;
  try {
    assertCurrent();
    admission = await authorizeProjectMemoryIndex(
      createPromptAttachmentAuthorizationContext(runtime, traceContext),
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    assertCurrent();
    if (
      error instanceof PromptAttachmentAuthorizationError &&
      [
        "enterprise_authority_changed",
        "enterprise_execution_context_changed",
        "enterprise_identity_changed",
        "enterprise_configuration_changed",
        "enterprise_authorization_cancelled",
      ].includes(error.code)
    )
      throw error;
    // 初次拒绝或不可用只省略 Memory，不阻断普通文本。
    return undefined;
  }
  assertCurrent();
  let read: Awaited<ReturnType<typeof fileSystemPort.readTextFile>> | undefined;
  try {
    read = await waitForAttachment(
      fileSystemPort.readTextFile({ path: indexPath }, { signal }),
      signal,
    );
  } catch {
    signal?.throwIfAborted();
    assertCurrent();
    // 缺失或不可读没有正文，但已捕获的 owner 仍须跨后继 Skills 等待复验。
  }
  assertCurrent();
  const formatted = read ? formatProjectMemoryIndexContent(read.content) : undefined;
  return {
    async authorizeCommit() {
      assertCurrent();
      try {
        await admission.revalidate();
      } catch (error) {
        signal?.throwIfAborted();
        assertCurrent();
        if (
          error instanceof PromptAttachmentAuthorizationError &&
          error.code === "enterprise_filesystem_denied"
        )
          return () => undefined;
        // owner/模式/证明失效不能借无 Memory 降级发布旧代待提交 context。
        throw error;
      }
      return () => {
        assertCurrent();
        admission.assertCurrent();
        if (!read || !formatted) return undefined;
        runtime.readFileState.set(createReadFileStateKey(indexPath, undefined, undefined), {
          content: read.content,
          isPartialView: formatted !== read.content,
          limit: undefined,
          mtimeMs: normalizeReadFileStateMtimeMs(read.revision?.mtimeMs),
          offset: undefined,
          path: indexPath,
          readAt: runtime.now(),
          revisionId: read.revision?.id,
          sizeBytes: read.sizeBytes,
        });
        return read.content;
      };
    },
  };
}
