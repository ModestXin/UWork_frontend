import { createNodeSkillAdapter, withEnterpriseSkillAuthorization } from "@zcode/adapters/skills";
import type { SkillPort, SkillRoot } from "@zcode/contracts";

/** One bootstrap path for main, workflow and draft skill consumers. */
export function createConfiguredSkillPort(input: {
  enabled: boolean;
  port?: SkillPort;
  roots: string[];
  resolvedRoots?: SkillRoot[];
  disabledPaths: string[];
  additionalDirectories?: readonly string[];
  context: Omit<Parameters<typeof withEnterpriseSkillAuthorization>[1], "enterprisePort">;
}): SkillPort | undefined {
  if (!input.enabled) return undefined;
  const port: SkillPort =
    input.port ??
    createNodeSkillAdapter({
      ...(input.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: input.additionalDirectories }),
      extraRoots: input.roots,
      extraResolvedRoots: input.resolvedRoots,
      disabledPaths: input.disabledPaths,
    });
  if (
    port.enterpriseAssetGuarded === true ||
    (!input.context.authorization && !input.context.catalog)
  )
    return port;
  return withEnterpriseSkillAuthorization(port, {
    ...input.context,
    enterprisePort: createNodeSkillAdapter({ includeZcodeSkills: false }),
  });
}
