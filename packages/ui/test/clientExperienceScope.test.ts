import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnterpriseIdentityView, UWorkClientPresentation } from "@zcode/shared";
import {
  clientExperienceScopeKey,
  currentClientExperienceValue,
} from "../src/hooks/clientExperienceScope.js";

const view = (revision: number): EnterpriseIdentityView => ({
  revision,
  configured: true,
  error: null,
  organizations: [],
  selectedOrgId: null,
  status: "authenticated",
  pending: null,
  profile: { id: "member", tenantId: "tenant", provider: "wecom", displayName: "Name" },
});
const presentation = (version: number): UWorkClientPresentation => ({
  status: "ready",
  version: 0,
  welcome: "",
  riskNotice: "Verify",
  riskPrefix: "AI",
  scenes: {
    status: "ready",
    version,
    data: { draftSuggestions: [], scheduledTemplates: [], offPeakTemplates: [] },
  },
  help: { status: "unsupported" },
  desktop: { status: "unsupported" },
  pluginStore: { status: "unsupported" },
});

test("stable service instances cannot reuse a previous identity or publication display scope", () => {
  const owner = {},
    other = {};
  const first = clientExperienceScopeKey(owner, view(1), presentation(1), "scenes");
  const revision = clientExperienceScopeKey(owner, view(2), presentation(1), "scenes");
  const replaced = clientExperienceScopeKey(other, view(1), presentation(1), "scenes");
  const published = clientExperienceScopeKey(owner, view(1), presentation(2), "scenes");
  for (const scope of [revision, replaced, published]) {
    assert.notEqual(scope, first);
    assert.equal(
      currentClientExperienceValue({ scope: first, value: "old tenant" }, scope),
      undefined,
    );
  }
  assert.equal(currentClientExperienceValue({ scope: first, value: "current" }, first), "current");
});

test("logout and read failures hide old values even before a new effect/request completes", () => {
  const owner = {};
  const first = clientExperienceScopeKey(owner, view(1), presentation(1), "scenes");
  const signedOut: EnterpriseIdentityView = {
    ...view(2),
    status: "signed-out",
    profile: null,
    pending: null,
  };
  const logout = clientExperienceScopeKey(owner, signedOut, null, "scenes");
  const failure = clientExperienceScopeKey(owner, view(1), { status: "unavailable" }, "scenes");
  for (const scope of [logout, failure])
    assert.equal(currentClientExperienceValue({ scope: first, value: "old" }, scope), undefined);
});
