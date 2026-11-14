# CLAUDE.md: Strutvane Files (`@strutvane/files`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

Layer 3 of [RFC-0002](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0002-file-storage-and-uploads.md): cloud disks (S3/R2/MinIO, Azure Blob), file/image field types, magic-byte validation, image decode + EXIF/GPS stripping, virus scanning (ClamAV), per-tenant quotas, the `files`/attachments lifecycle with orphan cleanup, and presigned direct-to-cloud uploads. The framework core (layer 2) owns the multipart parser, `UploadedFile` and the `local`/`memory` disks.

## Status

- **Implemented, version `0.1.0-next.0` (Changesets pre mode `next`), not released.** No GitHub repo yet; npm name `@strutvane/files` not reserved.
- **TEMPORARY:** `pnpm-workspace.yaml` links `@strutvane/contracts` and `@strutvane/core` to the sibling checkouts (`link:../…`) until both are on npm. `check-deps` rejects it; remove before pushing (ADR-0016).
- strutvane-tooling has no `files` sync target yet: the synced files here were copied from `logs` verbatim. Add the target in `tooling/manifest.json` and re-sync.

## Code map

| Path | What |
|---|---|
| `src/manager.ts` | `createFileManager`: store → commit/replace/detach → open/temporaryUrl → direct upload + confirm → scan → cleanup |
| `src/inspect.ts`, `src/validate.ts`, `src/rules.ts` | Pre-storage checks: size, magic-byte type, raster decode + strip, dimensions; rules and defaults |
| `src/mime.ts`, `src/keys.ts`, `src/size.ts` | Magic-byte detection, safe keys / tenant prefixes / file names, `'10MB'` sizes |
| `src/spool.ts`, `src/retry.ts`, `src/disk.ts`, `src/storage-metadata.ts` | Temp-file spooling, backoff + jitter → `STORAGE_UNAVAILABLE`, optional disk capabilities, provider-neutral metadata |
| `src/records.ts`, `src/quota.ts`, `src/scan.ts`, `src/variants.ts` | Record store + memory impl, quotas, scan policy, variant jobs |
| `src/fields.ts`, `src/errors.ts`, `src/messages.ts` | `fileField`/`imageField`/`filesField` (contracts `FieldType`), errors, message catalog |
| `src/s3/`, `src/azure/`, `src/images/`, `src/clamav/`, `src/sql/` | Subpath entries (optional peers) |
| `test/` | Unit + attack tests with fakes behind real SDK clients; `test/integration/` real services via Docker |

## Commands

- `corepack pnpm@12.18.0 run ci`: the gate (Biome → tsc → Vitest + coverage 90/90/85/90 → tsdown).
- `corepack pnpm@12.18.0 run test:integration`: SeaweedFS (S3 API), Azurite, PostgreSQL 18 with RLS. Containers are labelled `strutvane-files-test=1` and removed after.

## Gotchas

- Inside an `await using` scope, write `return await …`: disposal runs on return and would delete the temp file under a still-running upload.
- libvips caches open files; `disableFileCache()` (called by the sharp processor) is required or Windows can't delete temp files.
- The Bash tool collapses `\\` in heredocs: write files with backslash escapes through the editor, not shell heredocs.
- MinIO no longer publishes public images; the S3 integration suite uses SeaweedFS's S3 gateway.

## Boundaries (non-negotiable)

- Allowed dependencies: `@strutvane/contracts` and `@strutvane/core` only. Never import `framework`, `auth`, `ui` or `logs`. Key safety and MIME detection mirror the framework's rules (candidate to move into core).
- Cooperation with other packages happens only through contracts types, container tokens, hooks, events and the installer (integration map).
- Public API changes need a changeset, docs and tests. Contract changes need an RFC.
- Docker is local-only and never committed (ADR-0006). Secrets never in code, logs or `.env.example`.

## Where things are

- `.claude/skills/`: task playbooks (`upload-pipeline-change`, `strutvane-contribute`)
- `.claude/agents/`: `files-security-reviewer`, `strutvane-ecosystem-guardian`
- `.claude/commands/`: `/spec`, `/pre-pr`
