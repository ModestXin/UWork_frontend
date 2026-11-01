import assert from "node:assert/strict";
import { test } from "node:test";
import { connectWebBootstrap, WebBootstrapErrorScreen } from "../src/webBootstrapConnection.js";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("normal bootstrap connects and renders the original services once", async () => {
  const services = {};
  const rendered = [];
  let connections = 0;
  await connectWebBootstrap({
    connect: async () => {
      connections++;
      return services;
    },
    renderConnected: (value) => rendered.push(value),
    renderDisconnected: () => rendered.push("lost"),
  });
  assert.equal(connections, 1);
  assert.deepEqual(rendered, [services]);
});

test("actual close before the resolved continuation prevents a late old Root", async () => {
  const rendered = [];
  await connectWebBootstrap({
    connect: (onClose) => {
      onClose();
      return Promise.resolve({});
    },
    renderConnected: () => rendered.push("root"),
    renderDisconnected: () => rendered.push("lost"),
  });
  assert.deepEqual(rendered, ["lost"]);
});

test("close after Root retires it once without reconnect or duplicate render", async () => {
  const rendered = [];
  let close;
  let connections = 0;
  await connectWebBootstrap({
    connect: async (onClose) => {
      connections++;
      close = onClose;
      return {};
    },
    renderConnected: () => rendered.push("root"),
    renderDisconnected: () => rendered.push("lost"),
  });
  close();
  close();
  assert.deepEqual(rendered, ["root", "lost"]);
  assert.equal(connections, 1);
});

test("an initial failure followed by actual close stays an initial bootstrap failure", async () => {
  const rendered = [];
  const failure = new Error("controlled initial failure");
  let close;
  await assert.rejects(
    connectWebBootstrap({
      connect: (onClose) => {
        close = onClose;
        return Promise.reject(failure);
      },
      renderConnected: () => rendered.push("root"),
      renderDisconnected: () => rendered.push("lost"),
    }),
    (error) => error === failure,
  );
  close();
  assert.deepEqual(rendered, []);
});

test("close before a rejected connection cannot pretend that Root was connected", async () => {
  const rendered = [];
  await assert.rejects(
    connectWebBootstrap({
      connect: (onClose) => {
        onClose();
        return Promise.reject(new Error("controlled"));
      },
      renderConnected: () => rendered.push("root"),
      renderDisconnected: () => rendered.push("lost"),
    }),
  );
  assert.deepEqual(rendered, []);
});

for (const [kind, language, title, body, button] of [
  ["disconnected", "zh-CN", "连接已断开", "请重新连接后确认之前操作的结果。", "重试"],
  [
    "disconnected",
    "en-US",
    "Connection lost",
    "Reconnect, then check the outcome of your previous operation.",
    "Retry",
  ],
  ["bootstrap", "zh-CN", "Web 启动失败", "无法连接到服务，请重试。", "重试"],
  [
    "bootstrap",
    "en-US",
    "Web bootstrap failed",
    "Unable to connect to the server. Please try again.",
    "Retry",
  ],
]) {
  test(`${kind}/${language} uses static text, alert, heading focus target and native Retry button`, () => {
    const privateText = "PRIVATE_W02_REASON_wss://user:credential@owned.invalid/";
    const html = renderToStaticMarkup(
      createElement(WebBootstrapErrorScreen, {
        kind,
        language,
        onRetry() {},
        reason: privateText,
        message: privateText,
      }),
    );
    assert.equal(html.includes(title), true);
    assert.equal(html.includes(body), true);
    assert.equal(html.includes(privateText), false);
    assert.equal(html.includes('role="alert"'), true);
    assert.equal(html.includes('tabindex="-1"'), true);
    assert.equal(html.includes('<button type="button"'), true);
    assert.equal(html.includes("autofocus"), false);
    assert.equal(html.includes(`>${button}</button>`), true);
  });
}
