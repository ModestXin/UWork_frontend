# Personal skill management admission

## Product boundary

All six existing `ISkillsService` methods require current managed personal-skill admission: `allowFilesystem`, `personal.skills` and `security.dangerousSkills`. This completes the settings/mutation slice deferred by `uwork-enterprise-assets.md`. Existing list/prompt bodies and settings-sync skill imports already require these flags. The MCP configuration-storage/runtime distinction does not grant a skill-management exception. Public RPC names, parameters and results remain unchanged.

The real-filesystem RED under `evidence/client-skill-management-20261017/` found unguarded toggles, queued toggle writes after owner/FS replacement, copy after a parent mkdir wait and delete after a canonical-parent metadata wait. Copy/remove/delete already deny at entry through decorated `this.list`; that protection must remain. Remove's admitted rm may finish, but stale success after its wait must be rejected. RED is defect evidence, not proof of a repair.

## Owners and single path

`skillsService` remains the sole discovery/config writer and owns its original `writeQueue`. `UWorkBackendSession` remains the sole identity/configuration owner. Move the existing settings-sync skill access runner and explicit copier into one private `skills/skillAccess.ts` implementation used by both services. The Node composition injects the optional private backendSession into `createSkillsService`; delete the production outer body decorator. No Symbol RPC path, new identity field, permission cache, accepted queue or persisted owner is added.

Each public method structured-clones its params before any authorization wait and outside managed error sanitization, then enters the same runner once. Internal `listRaw` is shared by list, prompt and management without entering another session. Missing injected session and explicit UCAS retain original behavior, errors and zero policy HTTP; unmanaged work executes once outside managed error handling.

## Scope and I/O

One `backendSession.run` binds the operation's owner/configuration. Its real capture reads authority after its asynchronous `resolveConfig`; do not claim a synchronous call-entry identity snapshot. Every checkpoint reads `readHostSkillPolicy(scope)`, calls `scope.assertCurrent()` after that asynchronous read, then requires all three personal-skill flags. Entry and exit checkpoints use the same scope.

Actual SKILL.md/name-key reads, metadata/config reads, config mkdir/write, copy mutations, deletion rm and prompt audit mkdir/append run through the operation-local I/O callback. It checks before and after fulfilled or rejected awaited I/O, before processing returned bytes/errors or dispatching another effect. Existing catch/default/diagnostic paths cannot swallow enterprise access errors; normal FS fallbacks remain. The existing bounded directory walker is fenced before/after the whole metadata scan; this is not a claim that each internal metadata syscall is individually admitted.

List/prompt preserve the existing 70-second operation signal and abortable body-work race. Managed ordinary failures remain `enterprise_skill_read_failed`; policy/session errors retain their exact sanitized enterprise code. Management ordinary failures are `enterprise_skill_management_failed`; importer ordinary failures remain `enterprise_skill_sync_failed`. Unmanaged errors retain original identity. Mutations/imports wait for physical awaited I/O to settle before ending the operation or releasing their queue slot; the read-work race cannot wrap their complete work.

## Toggle ordering

Reserve a slot synchronously on the original queue, then begin the runner/capture before waiting for the previous slot:

```text
previous = writeQueue
task = runner(sameScope => await previous; checkpoint; original update)
queued = task.finally(() => previous)
writeQueue = queued.catch(() => {})
return queued
```

The `finally` dependency is required: a second operation whose capture/entry rejects must not release its reserved slot while its predecessor still has physical filesystem work in flight; a third call cannot overtake it. After queue wait the same scope checkpoints before discovery/read/modify/write. An old queued operation cannot capture a replacement owner on dequeue. Rejected operations leave earlier admitted writes intact and cannot poison the queue.

## Copy and deletion

Managed copy reuses the single existing explicit copier: lstat/readlink/readdir/realpath reads, regular-file read followed by exclusive write, exclusive directories and final chmod all use the same I/O access. Keep symlink, mode, occupied-target, and direct/aliased descendant refusal behavior. Unmanaged copy retains original cp. Do not duplicate the algorithm.

Delete retains plugin refusal, sourcePath leaf selection, parent-only realpath, existing workspace/user controlled roots and containment rules. Remove retains common-directory eligibility. Both check before dispatching rm and after it settles. A mutation already dispatched while allowed may finish after revocation; no later unauthorized effect or stale success may follow. Do not delete as denial handling, roll back accepted files, claim cancelled syscalls, or count a post-write failure as prevention of the preceding write.

```mermaid
sequenceDiagram
    participant Caller as Existing public skills caller
    participant Skills as Existing skillsService and writeQueue
    participant Session as Existing private backendSession
    participant Policy as Current backend policy
    participant FS as Owned filesystem
    Caller->>Skills: structured-cloned existing params
    Skills->>Skills: reserve original queue slot for toggle
    Skills->>Session: one run and real async capture
    Session->>Policy: current skill/FS checkpoint
    Session->>Session: assert same owner/configuration
    Session->>Skills: operation-local I/O access
    Skills->>Skills: await predecessor when toggling
    Skills->>Policy: same-scope checkpoint after wait
    Skills->>FS: admitted I/O dispatch
    FS-->>Skills: fulfilled or rejected physical settlement
    Skills->>Policy: same-scope checkpoint before continuation
    Note over Skills,FS: Accepted effects remain; denied next effects do not dispatch
    Skills->>Policy: final checkpoint
    Skills-->>Caller: current result or sanitized denial
```

## Acceptance

Keep the original four body-policy scenarios while migrating them to the injected real-FS service: deny before body and allowed list/prompt; logout/policy/FS after body discards both results; unmanaged unchanged with zero HTTP; managed sanitization and unmanaged original errors. Cover structured-clone capture and cancelled uncooperative body reads.

Promote real-FS RED cases into service regressions using the real session and controlled backend HTTP. Verify actual persisted bytes, content reads and effect dispatches. Delete's post-list metadata pause must follow actual body/config completion, not a policy-request-count heuristic. Include the three-toggle queue case with first physical write paused, second capture denied, and third allowed but unable to write before the first settles. Preserve allowed copy/delete/remove, symlink/containment rules, ordinary/rejected I/O fallback behavior, and importer regressions after moving its helper.

Run focused regressions, dedicated strict test typecheck, source regression, root typecheck/lint/target format and architecture checks. Source tests do not prove a rebuilt Native artifact. Root owns Desktop-only rebuild and actual Native retesting; this slice performs no CLI/out build and does not operate the shared Native fixture.

## Source verification checkpoint

The approved implementation passes 112/112 focused runner entries (body, management and unchanged importer regressions) and 266/266 services enterprise source entries. Dedicated strict management/body test typecheck and root client typecheck pass. Root lint reports 113 existing warnings and 0 errors with no new target-file warnings; target format, diff checks and architecture (0 violations, 0 baseline, 0 new) pass. Independent final source review found no Required issue and independently reran focused tests, strict test typecheck, architecture and diff checks. Root's rebuilt Native acceptance remains separate; no CLI/out build or Native test was performed by this implementation task.
