import type { ConversationShareCapabilities } from "@zcode/shared";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import type { ConversationSharePublicationAuthorization } from "./uworkPublicationPolicy.js";
import { ConversationShareClientError } from "./conversationShareHttpClient.js";

type ShareAgent = Pick<
  IZCodeAgentService,
  | "conversationRowsRangeV4"
  | "conversationFileChangesV4"
  | "conversationAttachmentReadV4"
  | "conversationAttachmentStatV4"
>;

/** 文件权限禁止时文本仍可分享；能力只用于本次投影，不作为下一次读取的准入缓存。 */
export async function localFileCapabilities(
  capabilities: ConversationShareCapabilities,
  authorization?: ConversationSharePublicationAuthorization,
): Promise<ConversationShareCapabilities> {
  if (!authorization?.managedScope || capabilities.allowed_artifacts.length === 0)
    return capabilities;
  try {
    await authorization.authorize(true);
    return capabilities;
  } catch (error) {
    if (!(error instanceof ConversationShareClientError) || error.kind !== "feature_disabled")
      throw error;
    // 文件许可失败不能掩盖身份或整个分享许可失效；重新裁决无文件的原 scope。
    await authorization.authorize(false);
    return { ...capabilities, max_artifact_count: 0, allowed_artifacts: [] };
  }
}

/** 原 publication/preflight scope 包围每次真实 IO，不能只在上传时才发现文件已被读取。 */
export function scopeConversationShareLocalFiles<A extends ShareAgent>(
  agent: A,
  source: ConversationShareArtifactSource,
  authorization?: ConversationSharePublicationAuthorization,
): { agent: A; source: ConversationShareArtifactSource } {
  if (!authorization?.managedScope) return { agent, source };
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    await authorization.authorize(true);
    const value = await operation();
    await authorization.authorize(true);
    return value;
  };
  return {
    source: {
      read: (input) => checked(() => source.read(input)),
      ...(source.stat
        ? {
            stat: (input: Parameters<NonNullable<ConversationShareArtifactSource["stat"]>>[0]) =>
              checked(() => source.stat!(input)),
          }
        : {}),
    },
    agent: {
      // 其余端口（工作流快照等）原样透传，分享实现需要完整 agent 合同。
      ...agent,
      conversationRowsRangeV4: (input) => agent.conversationRowsRangeV4(input),
      conversationFileChangesV4: (input) => checked(() => agent.conversationFileChangesV4(input)),
      conversationAttachmentReadV4: (input) =>
        checked(() => agent.conversationAttachmentReadV4(input)),
      conversationAttachmentStatV4: (input) =>
        checked(() => agent.conversationAttachmentStatV4(input)),
    },
  };
}
