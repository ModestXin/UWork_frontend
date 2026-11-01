import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ConversationSharePermissionPicker } from "../src/ConversationSharePermissionPicker.js";
import { ConversationShareConfirmationDock } from "../src/v4/ConversationShareConfirmationDock.js";

for (const [locale, label] of [
  ["zh-CN", "仅已登录企业成员可查看"],
  ["en-US", "Logged-in enterprise members can view"],
] as const) {
  test(`${locale}: actual permission component exposes only capability-admitted organization readonly`, () => {
    const html = renderToStaticMarkup(
      <ZCodeIntlProvider initialLocale={locale}>
        <ConversationSharePermissionPicker
          permission="organization"
          availableAccessModes={["organization"]}
          variant="compact"
          onChange={() => {}}
        />
      </ZCodeIntlProvider>,
    );
    assert.equal(html.match(/role="radio"/g)?.length, 1);
    assert.ok(html.includes(label));
    assert.ok(html.includes('data-conversation-share-permission="organization"'));
    assert.ok(html.includes('aria-checked="true"'));
    assert.ok(!html.includes('data-conversation-share-permission="private"'));
    assert.ok(!html.includes('data-conversation-share-permission="link-editor"'));
  });
}

test("capability unknown disables the actual confirmation control, without default public radios", () => {
  const html = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <ConversationShareConfirmationDock
        selectedCount={1}
        totalCount={1}
        title="Controlled"
        availableAccessModes={[]}
        disclosureAccepted
        onCancel={() => {}}
        onBack={() => {}}
        onConfirm={() => {}}
      />
    </ZCodeIntlProvider>,
  );
  assert.ok(html.includes("Sharing is unavailable"));
  assert.ok(!html.includes('role="radio"'));
  assert.ok(/disabled=""/.test(html));
});
