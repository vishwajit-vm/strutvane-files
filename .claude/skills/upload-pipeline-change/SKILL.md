---
name: upload-pipeline-change
description: Playbook for changing how @strutvane/files stores, validates, scans or serves files (manager, inspect, disks, records, quotas). Use before touching src/manager.ts, src/inspect.ts, a disk, or the SQL store.
---

# Changing the upload pipeline

1. **Find the scenario.** Locate the RFC-0002 §4 row(s) your change touches. If it adds a new failure mode, add a row to the RFC (hub repo) in the same change.
2. **Keep the order.** spool → inspect (size → type → decode/strip → dimensions) → dedupe → scan → quota → intent row (`uploading`) → bytes → `pending`. Nothing unvalidated may reach a disk; no bytes may exist without a row.
3. **Every exit cleans up.** Bytes deleted, row removed, quota released exactly once, temp files gone. In `await using` scopes, `return await`.
4. **Status changes are compare-and-set** through `FileRecordStore.update(…, from, …)`. Add the transition to the lifecycle diagram in `src/records.ts`.
5. **Tests:**
   - the happy path and every rejection path in `test/manager.test.ts` (the suite fails if a temp file leaks);
   - store behaviour in `test/helpers/store-contract.ts` (runs on memory, SQLite and PostgreSQL);
   - disk behaviour in `test/s3.test.ts` / `test/azure.test.ts`, and against real services in `test/integration/`.
6. Run `corepack pnpm@12.18.0 run ci`, then `run test:integration` (Docker), then the `files-security-reviewer` agent.
