# Plugin uninstall cache ownership

The existing marketplace installer owns `installed_plugins.json` and its derived cache under `cache/<marketplace>/<name>/<version>`. Updating a package replaces its installed record while retaining older version directories. The normal UI and bootstrap default `removeCache=true` promise removal of the uninstalled package's cached files and data. Removing only the latest `installPath` violates that promise; the current formal CLI reproduces V1 surviving a V1 → V2 → uninstall sequence.

## Required behavior

- With `removeCache=true`, removing the final ordinary installation of a cache owner removes every version in that owner's cache, plus its plugin data unless `keepData=true`. Source input directories, marketplace snapshots, dependencies, other plugins and other marketplaces remain intact.
- Derive the cache owner from the trusted storage root and valid marketplace/name components. Never expand deletion using `dirname(record.installPath)`. Reject ambiguous dot/path components and symlink ancestors; do not follow storage children outside the trusted root. A configured storage-root alias itself can resolve to its real directory.
- Installing or updating must also reject a cache version segment that sanitizes to empty, `.` or `..` before cache activation or installed-record commit. Such a segment can otherwise replace the package owner or its marketplace parent. Preserve the existing non-semver version support; this is a path ownership check, not a new semver requirement.
- Legacy installed records can contain multiple installations for the same ID or refer to the same cache owner. While any remaining record references that owner, retain its cache. Retain data while another installation references the same plugin data identity. The final removal performs the full cleanup.
- Official bundled assets have an existing immutable-cache and fallback contract. A registered bundled root protects its entire same-name official cache owner, including usable older fallback versions; existing seed-marked legacy assets are protected too. Downloaded official owners with no bundled ownership follow the ordinary cleanup rule. The separate builtin suppression/restore branch remains unchanged.
- `removeCache=false` retains cache and data exactly as before. `keepData=true` retains data while still removing unshared ordinary cache. Removing an absent installed ID remains a no-op.
- Keep existing installed-record persistence followed by cleanup/error behavior. A filesystem error is surfaced; do not claim rollback of record removal or deletion. No new persistent catalog, identity, permission, configuration writer or RPC field is introduced. User configuration cleanup remains with the existing bootstrap configuration owner; this change does not search or delete Workspace configuration.

```mermaid
sequenceDiagram
    participant Command as Existing plugin command
    participant Owner as Marketplace owner and storage lock
    participant Records as Installed records
    participant Cache as Derived cache and data
    Command->>Owner: uninstall(id, removeCache, keepData)
    Owner->>Records: remove existing record and persist remaining records
    Owner->>Cache: derive trusted owner; check remaining/bundled references
    alt ordinary final owner and cleanup requested
        Owner->>Cache: remove all owned cache versions; apply keepData
    else shared immutable/remaining ownership
        Owner->>Cache: preserve referenced cache/data
    end
    Owner-->>Command: existing result or cleanup error
```

## Verification

Use real temporary files and normal install/update APIs to reproduce V1 → V2 → cleanup before the fix. Guard `keepData`, `removeCache=false`, compatible remaining installations, bundled/fallback ownership, other cache owners, source inputs and unsafe path/symlink boundaries. Preserve the old formal CLI RED, then rebuild/stage through the normal CLI build and repeat the normal commands against the new artifact. Native installation, update and uninstall are a separate next acceptance slice, including a vetted actual official CDN package; Source/CLI checks do not close that UI slice.
