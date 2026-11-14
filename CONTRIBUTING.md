# Contributing to Strutvane Files

Thanks for your interest! Strutvane Files (`@strutvane/files`) is part of [Strutvane](https://github.com/vishwajit-vm/strutvane). Its spec is [RFC-0002](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0002-file-storage-and-uploads.md).

## Ground rules
- Be kind and constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
- Public API and contract changes go through an RFC before code.
- Every change ships with tests, docs and a changeset. Every security fix ships with a regression test for the whole class of bug.
- Sign off your commits (Developer Certificate of Origin): `git commit -s`.

## Development
Requirements: Node 24+ and pnpm (through corepack). Docker is optional, local-only and never committed (ADR-0006).

```bash
corepack pnpm@12.18.0 install
corepack pnpm@12.18.0 run ci                 # Biome → tsc → Vitest + coverage → tsdown (must pass)
corepack pnpm@12.18.0 run test:integration   # real S3-compatible server, Azurite, PostgreSQL (needs Docker)
```

The default gate uses in-process fakes behind the real SDK clients (so it runs on Windows/macOS CI without Docker); the integration suite runs the same disks against real services in throwaway containers that are always removed.
