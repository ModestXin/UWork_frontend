# Enterprise identity sharing entry

## Behavior and ownership

The existing desktop workspace header must offer the normal conversation sharing entry after the current enterprise identity is authenticated, including when the retired OAuth `user` value is null. It still requires an active task and `isDesktop !== false`.

`EnterpriseIdentityProvider` and its existing public `useEnterpriseIdentity` hook own the current identity projection. The header reads that projection; it does not restore OAuth, write a user store, copy a private session or add an accepted identity cache. Host `ConversationShareService`, the original private scope and the backend remain the final publication authorization owners. Entry visibility grants no publish permission.

When an identity context exists, only its current `view.status === "authenticated"` permits the entry. Signed-out, waiting, an unavailable view or an owner transition hides the entry even if a stale legacy user exists. A caller without an identity context preserves the old legacy-user display behavior. A newly authenticated replacement owner can show its own entry again.

```mermaid
sequenceDiagram
  participant Owner as Existing identity owner
  participant Provider as Existing identity provider
  participant Header as Workspace header
  participant Share as Existing share service
  Owner->>Provider: current public authenticated view
  Provider->>Header: public context snapshot
  Header->>Header: active task + desktop + current identity
  Header->>Share: normal user click and publish workflow
  Note over Share: Original private scope and backend authorize publication
  Owner->>Provider: owner change or sign-out
  Provider->>Header: missing or non-authenticated current view
  Header->>Header: hide; ignore stale legacy user
```

## Scope

Production change is limited to `packages/ui/src/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx`, using the existing hook. No RPC, share transport, identity owner, private credential, model permission, backend schema, Native artifact or CLI stage changes belong to this fix. No existing sharing specification is rewritten.

## Actual component regression

The standalone localhost Vite fixture renders the actual header, share menu, identity provider and public identity hook. Finite fixture-owned identity ports deliver only public views. Visible fixture controls emit identity changes or change ordinary component props. Browser Harness uses its own headless Chromium, profile and CDP endpoint, native input events, and read-only DOM/AX inspection. It must never call a product store, handler, IPC or React internal from automation.

Before production edits, the existing header must fail the authenticated-enterprise/null-legacy case and the stale-legacy/managed-signed-out case in a real browser. The identical regression must then pass after the fix, including actual share-button toggling and owner-change transitions.

Cases: enterprise authenticated with null legacy user; managed signed-out with stale legacy user; missing current view with stale legacy user; A authenticated to replacement owner pending to B authenticated to sign-out; active-task requirement; Web and unspecified desktop behavior; legacy caller without context; no-context caller without a legacy user.

## Commands and evidence

From the vendored client root, with its pinned Node 24.14 toolchain:

```sh
node scripts/check-workspace-freshness.mjs --no-fetch
pnpm architecture:check --changed
pnpm architecture:context ui
node packages/ui/test/enterpriseShareEntry.e2e.mjs /absolute/new/evidence/run-directory
pnpm exec tsc -p packages/ui/tsconfig.enterprise-share-entry-test.json
pnpm typecheck
pnpm lint
```

The runner creates its evidence directory exclusively, disables Vite environment-file loading, and uses an independent scratch directory. Cleanup observes only the runner and exact owned descendants, checks PID birth and both listener ports, closes the owned Browser Harness daemon and removes scratch only after all resources close. Never enumerate global processes, inspect PID 791, touch a user browser, read `.env` or inspect a retained Native root. A failure retains its evidence and does not count as a product RED unless the component assertion itself fails.

This verifies the actual browser component boundary. Installed Native sharing, a fresh official candidate, actual publication content and browser/default-browser or clipboard integration remain separate acceptance work.
