import assert from "node:assert/strict";
import { deserialize, serialize } from "node:v8";
import test from "node:test";
import {
  createDeepLinkSingleInstanceData,
  extractDeepLinkUrlFromSingleInstanceData,
  extractDeepLinkUrlFromArgs,
  extractOpenWorkspacePathFromArgs,
  extractOpenWorkspacePathFromSingleInstanceData,
} from "../src/main/desktopDeepLinkUrl.js";
import { handleSecondInstanceWorkspaceRequest } from "../src/main/desktopSecondInstanceDeepLink.js";

// Pinned Electron41.10.7/Chromium146 POSIX frame replay: native SplitString
// uses NUL + TRIM_WHITESPACE before it rejoins serialized additionalData.
// This is a real V8-byte contract, not a live native singleton invocation.
function oldNativeAdditionalData(value: unknown) {
  const encoded = serialize(value);
  const whitespace = new Set([9, 10, 11, 12, 13, 32]);
  const chunks: Buffer[] = [];
  let start = 0;
  for (let end = 0; end <= encoded.length; end++) {
    if (end !== encoded.length && encoded[end] !== 0) continue;
    let left = start,
      right = end;
    while (left < right && whitespace.has(encoded[left])) left++;
    while (right > left && whitespace.has(encoded[right - 1])) right--;
    chunks.push(encoded.subarray(left, right));
    start = end + 1;
  }
  const received = Buffer.concat(
    chunks.flatMap((chunk, index) => (index ? [Buffer.from([0]), chunk] : [chunk])),
  );
  assert.equal(
    received.length,
    encoded.length,
    "native additional_data_size exceeds payload length",
  );
  assert.deepEqual(received, encoded, "native wire must preserve every serialized byte");
  return deserialize(received);
}

// 旧 receiver 的原实现不识别 wire；这里继续调用未修改的原 Args 提取器。
function oldReceiverPath(data: Record<string, string>) {
  return extractOpenWorkspacePathFromArgs([`--open-workspace=${data.openWorkspacePath}`]);
}

for (const source of ["wide-slice", "unicode-trim"] as const) {
  test(`printable ASCII from ${source} uses safe one-byte storage without changing old receiver text`, () => {
    const plain = "/owned/ascii project with space %25";
    const input =
      source === "wide-slice" ? ("中" + plain + "中").slice(1, -1) : "\u3000" + plain + "\u3000";
    const data = oldNativeAdditionalData(
      createDeepLinkSingleInstanceData(["app", "--open-workspace", input]),
    );
    assert.equal(data.openWorkspacePath, plain);
    assert.equal(oldReceiverPath(data), plain);
  });
}

test("printable ASCII paths remain directly readable by the old receiver across lengths", () => {
  for (const length of [0, 1, 8, 9, 10, 13, 31, 32, 63, 64, 127, 128, 255, 256, 1023]) {
    const path = "/owned/" + "x".repeat(length) + " project space %2F%25";
    const data = oldNativeAdditionalData(
      createDeepLinkSingleInstanceData(["app", "--open-workspace", path]),
    );
    assert.equal(oldReceiverPath(data), path);
    assert.equal(data.openWorkspacePath, path);
  }
});

test("old receiver retains both safe ASCII fields and original percent URL", () => {
  const url = "zcode://workspace/open?path=%2Fowned%2F%252F%2525";
  const data = oldNativeAdditionalData(
    createDeepLinkSingleInstanceData(["app", url, "--open-workspace", "/owned/project space %25"]),
  );
  assert.equal(oldReceiverPath(data), "/owned/project space %25");
  assert.equal(extractDeepLinkUrlFromArgs([data.deepLinkUrl]), url);
  assert.deepEqual(data, { deepLinkUrl: url, openWorkspacePath: "/owned/project space %25" });
});

test("non-ASCII URI forces wire while preserving nested percent encoding exactly once", () => {
  const url = "zcode://workspace/open?path=%2Fowned%2F%252F%2525&label=中文";
  const data = oldNativeAdditionalData(createDeepLinkSingleInstanceData(["app", url]));
  assert.ok(data.deepLinkUrl.startsWith("uwork-si:v1:"));
  assert.equal(extractDeepLinkUrlFromSingleInstanceData(data), url);
  assert.equal(
    new URL(extractDeepLinkUrlFromSingleInstanceData(data)!).searchParams.get("path"),
    "/owned/%2F%25",
  );
});

test("literal wire-family text is encoded rather than interpreted as an extra decoding layer", () => {
  const value = "uwork-si:v1:%2Fmust-not-become-absolute";
  const data = oldNativeAdditionalData(
    createDeepLinkSingleInstanceData(["app", "--open-workspace", value]),
  );
  assert.notEqual(data.openWorkspacePath, value);
  assert.equal(extractOpenWorkspacePathFromSingleInstanceData(data), value);
});

test("production additionalData survives native trim with Chinese, spaces, emoji and percent paths", () => {
  for (const path of [
    "/owned/project 基线",
    "/owned/确认 中文 空格",
    "/owned/emoji 🧪 space",
    "/owned/%2F字面%25",
  ]) {
    const argv = ["app", "--open-workspace", path];
    const before = [...argv];
    const data = oldNativeAdditionalData(createDeepLinkSingleInstanceData(argv));
    assert.deepEqual(Object.keys(data as object), ["openWorkspacePath"]);
    assert.equal(extractOpenWorkspacePathFromSingleInstanceData(data), path);
    assert.deepEqual(argv, before);
  }
});

test("many payload lengths retain bytes and the complete logical path", () => {
  for (const length of [0, 1, 8, 9, 10, 13, 31, 32, 63, 64, 127, 128, 255, 256, 1023, 4096]) {
    const path = "/owned/" + "x".repeat(length) + " 中文 % literal 🧪";
    const data = oldNativeAdditionalData(
      createDeepLinkSingleInstanceData(["app", "--open-workspace", path]),
    );
    assert.equal(extractOpenWorkspacePathFromSingleInstanceData(data), path);
  }
});

test("wire decoding happens once and leaves URI percent encoding to the original URL parser", () => {
  const url = "zcode://workspace/open?path=" + encodeURIComponent("/owned/%2F 中文%25");
  const data = oldNativeAdditionalData(createDeepLinkSingleInstanceData(["app", url]));
  assert.equal(extractDeepLinkUrlFromSingleInstanceData(data), url);
  assert.equal(
    new URL(extractDeepLinkUrlFromSingleInstanceData(data)!).searchParams.get("path"),
    "/owned/%2F 中文%25",
  );
});

test("both logical fields and additionalData URL priority remain intact", () => {
  const url = "zcode://workspace/open?path=%2Fadditional";
  const data = oldNativeAdditionalData(
    createDeepLinkSingleInstanceData(["app", url, "--open-workspace", "/other 中文 path"]),
  );
  assert.deepEqual(Object.keys(data as object).sort(), ["deepLinkUrl", "openWorkspacePath"]);
  const seen: string[] = [];
  assert.equal(
    handleSecondInstanceWorkspaceRequest({
      argv: ["app", "zcode://workspace/open?path=%2Fargv"],
      additionalData: data,
      handleDeepLink: (value) => {
        seen.push(value);
        return true;
      },
      handleOpenWorkspacePath: () => assert.fail("URL must retain the external confirmation route"),
    }),
    true,
  );
  assert.deepEqual(seen, [url]);
});

test("legacy raw objects retain their original extraction contract", () => {
  assert.equal(
    extractOpenWorkspacePathFromSingleInstanceData({ openWorkspacePath: "/legacy 中文 space" }),
    "/legacy 中文 space",
  );
  assert.equal(
    extractDeepLinkUrlFromSingleInstanceData({
      deepLinkUrl: "zcode://workspace/open?path=%2Flegacy",
    }),
    "zcode://workspace/open?path=%2Flegacy",
  );
  assert.equal(extractOpenWorkspacePathFromSingleInstanceData(null), null);
  assert.equal(extractOpenWorkspacePathFromSingleInstanceData({ openWorkspacePath: 1 }), null);
});

test("unknown versions and malformed or non-ASCII wire data reject then use original argv fallback", () => {
  for (const wire of [
    "uwork-si:v2:%2Fbad",
    "uwork-si:v1:%",
    "uwork-si:v1:%C0%AF",
    "uwork-si:v1:中文",
    " uwork-si:v99:%2Fbad ",
  ]) {
    const data = { openWorkspacePath: wire };
    assert.equal(extractOpenWorkspacePathFromSingleInstanceData(data), null);
    assert.equal(extractDeepLinkUrlFromSingleInstanceData({ deepLinkUrl: wire }), null);
    const seen: string[] = [];
    assert.equal(
      handleSecondInstanceWorkspaceRequest({
        argv: ["app", "--open-workspace", "/argv"],
        additionalData: data,
        handleDeepLink: () => false,
        handleOpenWorkspacePath: (value) => {
          seen.push(value);
          return true;
        },
      }),
      true,
    );
    assert.deepEqual(seen, ["/argv"]);
  }
});

test("NUL and UNC are transported unchanged for existing admission checks, never double decoded", () => {
  for (const path of ["/owned/has\0nul", "\\\\server\\share", "//server/share", "/owned/%00"]) {
    const data = oldNativeAdditionalData(
      createDeepLinkSingleInstanceData(["app", "--open-workspace", path]),
    );
    assert.equal(extractOpenWorkspacePathFromSingleInstanceData(data), path);
  }
});

test("invalid UTF16 argv does not throw while constructing additionalData", () => {
  const argv = ["app", "--open-workspace", "/owned/\ud800"];
  const before = [...argv];
  const data = createDeepLinkSingleInstanceData(argv);
  assert.deepEqual(data, {});
  assert.deepEqual(argv, before);
  const seen: string[] = [];
  assert.equal(
    handleSecondInstanceWorkspaceRequest({
      argv,
      additionalData: data,
      handleDeepLink: () => false,
      handleOpenWorkspacePath: (value) => {
        seen.push(value);
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(seen, ["/owned/\ud800"]);
});
