# Phase two implementation plan

Spec: ../specs/2026-10-21-harness-phase-two-design.md
Base: 10e6dd1. Execute inline with TDD; one independent final review.

Global constraints: same-origin local API, no automatic model calls, bounded buffers, original and derived provenance, preserve phase-one behavior.

- [ ] 1. Durable chunk upload repository. Write restart/checksum/idempotency/limit tests, observe RED, implement, run suite. Interface: create/status/put/complete/contentPath; immutable manifests after completion.
- [ ] 2. Bounded local preprocessing and offline speech bridge. Test selected ranges and missing tools/models; implement extraction with coverage metadata, verify real tools.
- [ ] 3. API and task material integration. Test upload routes, material validation and paused-to-ready behavior; preserve source messages and model budgets.
- [ ] 4. Browser attachments and editable voice flow. Test no upload before send, resumable upload, scope display, error recovery, original transcript separate from edited message.
- [ ] 5. Acceptance and environment documentation. Run unit/type/build/browser checks and 1 GiB restart test. Independent review, reproduce and fix important findings, commit.

Review focus: malicious filenames/IDs, concurrent writes/finalization, disk exhaustion, crash between file and manifest writes, unsupported media, forged preprocessing scope, stale browser retries and missing speech model.
