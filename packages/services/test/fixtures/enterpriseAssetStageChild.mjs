import { createHash } from "node:crypto";
import { createEnterpriseAssetStore } from "../../src/enterprise-assets/assetStore.ts";

const content = {
  files: [
    { path: "SKILL.md", content: "# Controlled crash stage" },
    { path: "references/data.txt", content: "controlled" },
  ],
  highRisk: false,
};
let fences = 0;
await createEnterpriseAssetStore({ root: process.argv[2] }).materialize(
  {
    id: "controlled-asset",
    kind: "skill",
    version: 2,
    content,
    checksum: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  },
  {
    traceId: "controlled-crash-trace",
    isCurrent() {
      if (++fences === 6) {
        process.stdout.write("controlled-stage-ready\n");
        process.kill(process.pid, "SIGSTOP");
      }
      return true;
    },
  },
);
