// 执行真实协议与冷启动 gate 源码；fixture 控制 Electron/FS 边界，不冒充原生 OS。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixture,
  dialog,
  flush,
  opened,
  requestWire,
} from "./externalWorkspaceConfirmation.fixture.mjs";

test("versioned URI still waits for original consent and cancellation performs no stat or IPC", async () => {
  const f = fixture();
  assert.equal(requestWire(f, "/owned/中文 space %2F 🧪"), true);
  const pending = await dialog(f);
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
  pending.accept({ response: 1 });
  await flush();
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
});

test("wire UNC is rejected before consent and wire NUL remains invalid before stat", async () => {
  for (const path of ["\\\\server\\share", "//server/share"]) {
    const f = fixture();
    assert.equal(requestWire(f, path), false);
    await flush();
    assert.equal(f.calls.length, 0);
    assert.equal(f.stats.length, 0);
    assert.equal(f.sent.length, 0);
  }
  const f = fixture();
  assert.equal(requestWire(f, "/owned/has\0nul"), true);
  const pending = await dialog(f);
  pending.accept({ response: 0 });
  await flush();
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
});

test("recognized workspace is consumed synchronously while confirmation waits without stat or IPC", async () => {
  const f = fixture();
  assert.equal(f.request("/owned space/测试"), true);
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
  const pending = await dialog(f);
  assert.equal(f.api.handleDeepLink("zcode://unrecognized-owned-test", f.logger), false);
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(pending.options.defaultId, 1);
  assert.equal(pending.options.cancelId, 1);
  pending.accept({ response: 0 });
  await flush();
  assert.deepEqual(f.stats, ["/owned space/测试"]);
  assert.deepEqual(opened(f), [
    { windowId: f.win.id, channel: "open-workspace", value: "/owned space/测试" },
  ]);
});

test("two external requests serialize confirmation and a cancellation never stats or routes its path", async () => {
  const f = fixture();
  assert.equal(f.request("/cancelled"), true);
  assert.equal(f.request("/accepted"), true);
  const first = await dialog(f);
  assert.equal(f.calls.length, 1, "Only one native confirmation may be shown");
  first.accept({ response: 1 });
  const second = await dialog(f, 1);
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
  second.accept({ response: 0 });
  await flush();
  assert.deepEqual(f.stats, ["/accepted"]);
  assert.deepEqual(
    opened(f).map((row) => row.value),
    ["/accepted"],
  );
});

test("UNC and missing-path URLs reject before any native confirmation or filesystem probe", async () => {
  const f = fixture();
  assert.equal(f.request("//server/share"), false);
  assert.equal(f.api.handleDeepLink("zcode://workspace/open", f.logger), false);
  await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.syncCalls.length, 0);
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
});

for (const invalidation of ["destroyed", "contentsDestroyed"]) {
  test(`${invalidation} before queued confirmation cannot show a dialog or route`, async () => {
    const f = fixture();
    const result = f.api.confirmExternalWorkspaceOpen(
      "/owned",
      f.logger,
      f.win,
      undefined,
      () => f.state.active,
    );
    f.win[invalidation] = true;
    assert.equal(await result, false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.syncCalls.length, 0);
    assert.equal(f.stats.length, 0);
    assert.equal(f.sent.length, 0);
  });

  test(`${invalidation} while native confirmation waits withholds its later allow`, async () => {
    const f = fixture();
    assert.equal(f.request("/owned"), true);
    const pending = await dialog(f);
    f.win[invalidation] = true;
    pending.accept({ response: 0 });
    await flush();
    assert.equal(f.stats.length, 0);
    assert.equal(f.sent.length, 0);
  });
}

test("window focus changes do not redirect an accepted external request to another window", async () => {
  const f = fixture();
  assert.equal(f.request("/original-window"), true);
  const pending = await dialog(f);
  const other = f.window();
  f.api.deliverPendingDeepLink(other.webContents);
  f.state.focused = other;
  pending.accept({ response: 0 });
  await flush();
  assert.equal(opened(f).filter((row) => row.windowId === other.id).length, 0);
  assert.equal(opened(f).length, 1, "A live original window must retain its accepted request");
  assert.ok(opened(f).every((row) => row.windowId === f.win.id));
});

test("window destroyed after confirmation postcheck but before routing cannot receive stale consent", async () => {
  const f = fixture();
  let nativeResolved = false;
  let closeQueued = false;
  assert.equal(
    f.request("/owned", {
      isRequestActive: () => {
        if (nativeResolved && !closeQueued) {
          closeQueued = true;
          queueMicrotask(() => {
            f.win.destroyed = true;
          });
        }
        return f.state.active;
      },
    }),
    true,
  );
  const pending = await dialog(f);
  nativeResolved = true;
  pending.accept({ response: 0 });
  // 在确认函数的 postcheck 内安排关闭微任务，严格位于 boolean 消费 continuation 之前。
  await flush();
  assert.equal(closeQueued, true);
  assert.equal(f.stats.length, 0, "Destroyed owner cannot probe a formerly accepted path");
  assert.equal(f.sent.length, 0);
});

test("cold-start parent destroyed between confirmation resolution and bootstrap consumption returns null", async () => {
  const f = fixture();
  let nativeResolved = false;
  let closeQueued = false;
  const result = f.api.resolveExplicitStartupWorkspaceBootstrap(
    { path: "/cold", source: "deep-link" },
    {
      logger: f.logger,
      parentWindow: f.win,
      isRequestActive: () => {
        if (nativeResolved && !closeQueued) {
          closeQueued = true;
          queueMicrotask(() => {
            f.win.contentsDestroyed = true;
          });
        }
        return f.state.active;
      },
    },
  );
  const pending = await dialog(f);
  nativeResolved = true;
  pending.accept({ response: 0 });
  assert.equal(await result, null);
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
});

test("request deactivated before its queued turn does not display a native dialog", async () => {
  const f = fixture();
  const result = f.api.confirmExternalWorkspaceOpen(
    "/owned",
    f.logger,
    f.win,
    undefined,
    () => f.state.active,
  );
  f.state.active = false;
  assert.equal(await result, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.syncCalls.length, 0);
});

test("shutdown during confirmation prevents stat, pending workspace and IPC even after allow", async () => {
  const f = fixture();
  assert.equal(f.request("/owned"), true);
  const pending = await dialog(f);
  f.state.active = false;
  pending.accept({ response: 0 });
  await flush();
  assert.equal(f.stats.length, 0);
  assert.equal(f.sent.length, 0);
  f.api.deliverPendingDeepLink(f.win.webContents);
  assert.equal(f.sent.length, 0, "No deferred workspace may revive on a later ready event");
});

test("native dialog rejection is contained and the following confirmation can proceed", async () => {
  const f = fixture();
  const rejected = f.api.confirmExternalWorkspaceOpen("/failure", f.logger, f.win);
  const following = f.api.confirmExternalWorkspaceOpen("/next", f.logger, f.win);
  const first = await dialog(f);
  first.reject(new Error("Owned dialog failure"));
  assert.equal(await rejected, false);
  const second = await dialog(f, 1);
  second.accept({ response: 0 });
  assert.equal(await following, true);
  assert.ok(f.warnings.length > 0);
  assert.equal(f.calls.length, 2);
});

test("cold-start external workspace bootstrap waits for consent before stat or choosing workspace", async () => {
  const f = fixture();
  const result = f.api.resolveExplicitStartupWorkspaceBootstrap(
    { path: "/cold", source: "deep-link" },
    {
      logger: f.logger,
      parentWindow: f.win,
      isRequestActive: () => f.state.active,
    },
  );
  assert.equal(
    typeof result?.then,
    "function",
    "Cold bootstrap must await its native confirmation",
  );
  let settled = false;
  result.then(() => {
    settled = true;
  });
  const pending = await dialog(f);
  assert.equal(settled, false);
  assert.equal(f.stats.length, 0);
  pending.accept({ response: 0 });
  const value = await result;
  assert.equal(value.initialWorkspacePath, "/cold");
  assert.equal(value.initialWorkspacePurpose, "project");
  assert.deepEqual(f.stats, ["/cold"]);
  assert.equal(
    f.sent.length,
    0,
    "Cold bootstrap chooses its first window rather than sending ready IPC",
  );
});

for (const outcome of ["cancel", "shutdown"]) {
  test(`cold-start ${outcome} returns null without filesystem probing`, async () => {
    const f = fixture();
    const result = f.api.resolveExplicitStartupWorkspaceBootstrap(
      { path: "/cold", source: "deep-link" },
      {
        logger: f.logger,
        parentWindow: f.win,
        isRequestActive: () => f.state.active,
      },
    );
    const pending = await dialog(f);
    if (outcome === "shutdown") f.state.active = false;
    pending.accept({ response: outcome === "cancel" ? 1 : 0 });
    assert.equal(await result, null);
    assert.equal(f.stats.length, 0);
    assert.equal(f.sent.length, 0);
  });
}

test("trusted explicit startup argv keeps its direct directory path without an external dialog", async () => {
  const f = fixture();
  const value = await f.api.resolveExplicitStartupWorkspaceBootstrap(
    { path: "/explicit", source: "open-workspace-arg" },
    { logger: f.logger },
  );
  assert.equal(value.initialWorkspacePath, "/explicit");
  assert.equal(f.calls.length, 0);
  assert.equal(f.syncCalls.length, 0);
  assert.deepEqual(f.stats, ["/explicit"]);
});
