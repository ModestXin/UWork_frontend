import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSkillsFailureMessageId } from "../src/settings/skillsFailureCopy.js";

test("a rejected personal skill read explains enterprise permission", () => {
  assert.equal(
    resolveSkillsFailureMessageId("enterprise_personal_skills_denied"),
    "settings.skills.enterprisePolicyDenied",
  );
});

test("unavailable policy and changed identity give separate recovery actions", () => {
  assert.equal(
    resolveSkillsFailureMessageId("enterprise_policy_unavailable"),
    "settings.skills.enterprisePolicyUnavailable",
  );
  for (const error of [
    "enterprise_runtime_obsolete",
    "enterprise_identity_changed",
    "enterprise_configuration_changed",
  ])
    assert.equal(resolveSkillsFailureMessageId(error), "settings.skills.enterpriseRuntimeChanged");
});

test("unknown error or arbitrary supplier prose is not recategorized", () => {
  assert.equal(resolveSkillsFailureMessageId("disk read failed"), undefined);
  assert.equal(
    resolveSkillsFailureMessageId("upstream mentions enterprise_personal_skills_denied"),
    undefined,
  );
});

test("filesystem denial identifies the file policy rather than the personal skill switch", () => {
  assert.equal(
    resolveSkillsFailureMessageId("enterprise_filesystem_denied"),
    "settings.skills.enterpriseFilesystemDenied",
  );
  assert.equal(
    resolveSkillsFailureMessageId("upstream mentions enterprise_filesystem_denied"),
    undefined,
  );
});
