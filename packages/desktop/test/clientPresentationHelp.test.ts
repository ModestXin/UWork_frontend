import assert from "node:assert/strict";
import { test } from "node:test";
import { openBoundClientHelp } from "../src/main/clientPresentationHelp.js";
import type { BoundClientPresentation } from "../src/main/clientPresentationBindings.js";

test("managed help honors null and disabled without falling back to a local feedback dialog", async () => {
  let opened = 0;
  const bound: BoundClientPresentation = {
    bindingEpoch: "controlled:1",
    projection: {
      status: "ready",
      desktop: { status: "unsupported" },
      help: {
        status: "ready",
        version: 1,
        data: {
          communityUrls: { "zh-CN": null, "en-US": "https://help.example.test/" },
          feedback: { mode: "disabled", url: null },
        },
      },
    },
  };
  for (const kind of ["community", "feedback"] as const)
    assert.equal(
      await openBoundClientHelp({
        senderId: 1,
        kind,
        locale: "zh-CN",
        read: async () => bound,
        isCurrent: () => true,
        open: async () => {
          opened++;
        },
      }),
      true,
    );
  assert.equal(opened, 0);
  assert.equal(
    await openBoundClientHelp({
      senderId: 1,
      kind: "community",
      locale: "en-US",
      read: async () => bound,
      isCurrent: () => true,
      open: async (url) => {
        assert.equal(url, "https://help.example.test/");
        opened++;
      },
    }),
    true,
  );
  assert.equal(opened, 1);
  assert.equal(
    await openBoundClientHelp({
      senderId: 1,
      kind: "community",
      locale: "en-US",
      read: async () => bound,
      isCurrent: () => false,
      open: async () => {
        opened++;
      },
    }),
    true,
  );
  assert.equal(
    opened,
    1,
    "a help read completed after a window/owner change cannot open the old URL",
  );
  assert.equal(
    await openBoundClientHelp({
      senderId: 1,
      kind: "community",
      locale: "en-US",
      read: async () => ({ bindingEpoch: "unmanaged", projection: { status: "unmanaged" } }),
      isCurrent: () => true,
      open: async () => {
        opened++;
      },
    }),
    false,
  );
  assert.equal(opened, 1);
});
