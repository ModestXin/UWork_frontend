import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnterpriseIdentityView } from "@zcode/shared";
import { createEnterpriseLoginErrorPresentation } from "../src/hooks/enterpriseLoginErrorPresentation.js";

const view = (
  revision: number,
  phase: "clear" | "failed" | "waiting" | "authenticated",
  id = "current",
): EnterpriseIdentityView =>
  ({
    revision,
    configured: true,
    status:
      phase === "waiting" ? "waiting" : phase === "authenticated" ? "authenticated" : "signed-out",
    profile:
      phase === "authenticated"
        ? { id: "user", tenantId: "tenant", provider: "wecom", displayName: "Owned" }
        : null,
    pending:
      phase === "waiting"
        ? { id, expiresAt: 100, callbackUrl: "https://identity.fixture/callback" }
        : null,
    error: phase === "failed" ? "failed" : null,
    organizations: [],
    selectedOrgId: null,
  }) as EnterpriseIdentityView;
const create = () => createEnterpriseLoginErrorPresentation(() => {});

test("initial failure is visible; explicit clear ignores retained failed republish", () => {
  const hint = create();
  hint.observe(view(1, "failed"));
  assert.equal(hint.visible, true);
  hint.begin("clear");
  hint.observe(view(2, "failed"));
  assert.equal(hint.visible, false);
});

test("current selection success clears; stale selection cannot clear or report a newer error", () => {
  const hint = create();
  const old = hint.begin("selection");
  const current = hint.begin("admission");
  hint.fail(current);
  hint.succeed(old);
  assert.equal(hint.visible, true);
  const selected = hint.begin("selection");
  hint.succeed(selected);
  hint.fail(old);
  assert.equal(hint.visible, false);
});

test("current selection persistence failure is visible without changing Host view", () => {
  const hint = create();
  hint.fail(hint.begin("selection"));
  assert.equal(hint.visible, true);
});

test("each no-ID begin rejection is visible despite identical Host failed diagnostics", () => {
  const hint = create();
  for (let revision = 1; revision <= 2; revision++) {
    const ticket = hint.begin("admission");
    hint.admit(ticket);
    hint.observe(view(revision, "failed"));
    assert.equal(hint.visible, false);
    hint.fail(ticket);
    assert.equal(hint.visible, true);
  }
});

test("bound current waiting to failed is visible before any Promise settles", () => {
  const hint = create();
  const ticket = hint.begin("admission");
  hint.admit(ticket);
  hint.observe(view(1, "waiting"));
  assert.equal(hint.bind(ticket, "current"), false);
  hint.observe(view(2, "failed"));
  assert.equal(hint.visible, true);
});

test("late begin ID confirms cached failure through republish and older waiting snapshot", () => {
  const hint = create();
  const ticket = hint.begin("admission");
  hint.admit(ticket);
  hint.observe(view(1, "waiting"));
  hint.observe(view(2, "failed"));
  hint.observe(view(3, "failed"));
  hint.observe(view(1, "waiting"));
  assert.equal(hint.visible, false, "do not guess attempt ownership before begin ID");
  assert.equal(hint.bind(ticket, "current"), true);
  assert.equal(hint.visible, true);
});

test("failure for an old ID is not attributed to a different begin ID", () => {
  const hint = create();
  const ticket = hint.begin("admission");
  hint.admit(ticket);
  hint.observe(view(1, "waiting", "old"));
  hint.observe(view(2, "failed"));
  assert.equal(hint.bind(ticket, "current"), false);
  assert.equal(hint.visible, false);
});

test("admission boundary forgets old pending-start events while waiting for cancellation", () => {
  const hint = create();
  const ticket = hint.begin("admission");
  hint.observe(view(1, "waiting", "old"));
  hint.observe(view(2, "failed"));
  hint.admit(ticket);
  assert.equal(hint.bind(ticket, "old"), false);
  assert.equal(hint.visible, false);
});

test("skip/back retire old Promise errors; a new operation retains its own failure", () => {
  const hint = create();
  const old = hint.begin("admission");
  hint.begin("clear");
  hint.fail(old);
  assert.equal(hint.visible, false);
  const current = hint.begin("admission");
  hint.fail(current);
  hint.succeed(old);
  assert.equal(hint.visible, true);
});

test("authenticated view retires hint and late begin ID cannot revive it", () => {
  const hint = create();
  const ticket = hint.begin("admission");
  hint.admit(ticket);
  hint.observe(view(1, "waiting"));
  hint.observe(view(2, "authenticated"));
  hint.observe(view(1, "failed"));
  assert.equal(hint.bind(ticket, "current"), false);
  hint.fail(ticket);
  assert.equal(hint.visible, false);
  assert.equal(hint.isCurrent(ticket), false);
});

test("owner-specific helper cannot report into a fresh owner's presentation", () => {
  const a = create(),
    b = create();
  const old = a.begin("selection");
  a.begin("clear");
  b.fail(b.begin("admission"));
  a.fail(old);
  assert.equal(a.visible, false);
  assert.equal(b.visible, true);
});
