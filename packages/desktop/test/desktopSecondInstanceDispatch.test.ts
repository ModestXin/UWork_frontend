import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSecondInstanceWorkspaceRequest } from "../src/main/desktopSecondInstanceDeepLink.js";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("native notification returns before external workspace handling starts", async () => {
  const events: string[] = [];
  dispatchSecondInstanceWorkspaceRequest(
    {
      argv: ["app", "zcode://workspace/open?path=%2Fowned"],
      additionalData: undefined,
      handleDeepLink: () => {
        events.push("confirmation");
        return true;
      },
      handleOpenWorkspacePath: () => {
        throw new Error("URL request must retain its confirmation path");
      },
    },
    () => {
      throw new Error("Recognized request must not focus fallback");
    },
  );
  events.push("native-notification-returned");
  assert.deepEqual(events, ["native-notification-returned"]);
  await nextTurn();
  assert.deepEqual(events, ["native-notification-returned", "confirmation"]);
});

test("unhandled request focuses the original window only after notification returns", async () => {
  let focused = 0;
  dispatchSecondInstanceWorkspaceRequest(
    {
      argv: ["app", "--unrelated"],
      additionalData: null,
      handleDeepLink: () => false,
      handleOpenWorkspacePath: () => false,
    },
    () => {
      focused++;
    },
  );
  assert.equal(focused, 0);
  await nextTurn();
  assert.equal(focused, 1);
});

test("queued event retains argv and additionalData priority", async () => {
  const argv = ["app", "zcode://workspace/open?path=%2Fargv"];
  const urls: string[] = [];
  dispatchSecondInstanceWorkspaceRequest(
    {
      argv,
      additionalData: { deepLinkUrl: "zcode://workspace/open?path=%2Fadditional" },
      handleDeepLink: (url) => {
        urls.push(url);
        return true;
      },
      handleOpenWorkspacePath: () => false,
    },
    () => assert.fail("Valid additionalData must be handled"),
  );
  argv.splice(0, argv.length, "other");
  await nextTurn();
  assert.deepEqual(urls, ["zcode://workspace/open?path=%2Fadditional"]);
});

test("two independent native events retain their own arguments and order", async () => {
  const urls: string[] = [];
  for (const path of ["first", "second"]) {
    const argv = ["app", `zcode://workspace/open?path=%2F${path}`];
    dispatchSecondInstanceWorkspaceRequest(
      {
        argv,
        additionalData: null,
        handleDeepLink: (url) => {
          urls.push(url);
          return true;
        },
        handleOpenWorkspacePath: () => false,
      },
      () => assert.fail("Valid URL must be handled"),
    );
    argv[1] = "zcode://workspace/open?path=%2Fmutated";
  }
  await nextTurn();
  assert.deepEqual(urls, [
    "zcode://workspace/open?path=%2Ffirst",
    "zcode://workspace/open?path=%2Fsecond",
  ]);
});

test("original explicit workspace fallback is preserved after a rejected URL", async () => {
  const paths: string[] = [];
  dispatchSecondInstanceWorkspaceRequest(
    {
      argv: ["app", "zcode://unknown", "--open-workspace", "/owned"],
      additionalData: null,
      handleDeepLink: () => false,
      handleOpenWorkspacePath: (path) => {
        paths.push(path);
        return true;
      },
    },
    () => assert.fail("Explicit workspace must still route through original handler"),
  );
  assert.deepEqual(paths, []);
  await nextTurn();
  assert.deepEqual(paths, ["/owned"]);
});

test("queued native notification is discarded when shutdown begins before the next turn", async () => {
  let active = true;
  let handled = 0;
  let focused = 0;
  dispatchSecondInstanceWorkspaceRequest(
    {
      argv: ["app", "zcode://unknown"],
      additionalData: null,
      isRequestActive: () => active,
      handleDeepLink: () => {
        handled++;
        return false;
      },
      handleOpenWorkspacePath: () => false,
    },
    () => {
      focused++;
    },
  );
  active = false;
  await nextTurn();
  assert.equal(handled, 0);
  assert.equal(focused, 0);
});
