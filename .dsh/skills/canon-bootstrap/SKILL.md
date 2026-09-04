---
name: canon-bootstrap
description: Bootstrap or import a repository's documentation canon.
---

# Canon Bootstrap

## Safety and source of truth

- The source of truth (SoT) is `docs/canon/`; start from `docs/canon/INDEX.md`.
- Never modify application code. Edit only `docs/canon/**`; managed paths may be changed only by CLI upgrade flows.
- Always run `doc-canon validate --json` before claiming success on canon edits; success requires exit 0 and zero `error`-severity issues.
- Keep prose and list lines within the contract's `policies.max_line_length` (default 500 chars); wrap long lines into continuation lines instead of single walls of text. Table rows and fenced code blocks are exempt (table rows cannot be wrapped).
- If `doc-canon` is missing on PATH, stop and give an install hint: `npm install -g doc-canon` or use a local npx invocation. Do not continue without validation.

## Documentation coverage checklist

When filling canon sections (mandatory or agreed extras), cover each required content category below, or explicitly exclude it in that section's Scope with a reason. This is an authorship discipline, not validator-enforced structure; keep the registered template's required headings and add coverage as the section's key details / responsibilities / flows call for.

- **Public interfaces** — public inputs, outputs, and contracts; observable signals (exit codes ≠0, warnings, `--json` shape)
- **Workflows / key flows** — order of steps for each main operation
- **Usage examples** — working command examples with flags and expected results
- **Operational runbooks** — startup, configuration, upgrade, rollback, recovery
- **Failure modes / error handling** — what can break, how failure is signaled, how to recover
- **Success criteria** — observable signs that the system works as documented

## Workflow

1. If the canon scaffold is missing, call `doc-canon init`.
2. Detect whether the project is empty or non-empty and interview the user before writing.
3. For an empty project, ask for purpose and scope, fill the mandatory files from their registered templates, refresh `INDEX.md`, and validate.
4. For a non-empty project, use extract-then-freeze:
   - Run a fresh inventory.
   - Read README files, existing docs, and agent instructions as import sources, not as authority.
   - Propose extra sections, interview the user, and use the contract workflow for confirmed structural changes.
   - Extract agreed facts into files created from registered templates, then refresh `INDEX.md`.
5. Run `doc-canon validate --json`. After it succeeds, import sources outside `docs/canon/` are not SoT. Do not delete or silently update those legacy files.
6. Build the retrieval indexes: run `doc-canon index` (canon BM25) and, when covered source exists, `doc-canon code-index build`. Later goal steps run `doc-canon scout "<topic>"` first — mandatory when the indexes exist — and use the returned working-set manifest (ranked paths with contract roles, snippet stubs, verdict hint); scout seeds the code pack automatically when a code index exists, else it is docs-only. If scout fails closed, run `doc-canon index` (and `code-index build` when covered source exists), then re-run scout; only if building fails, read source as evidence and note the miss (`code_miss: <query> -> source:<path>` / `doc_miss: <query> -> docs:<path>`). Scout/search failure alone never licenses INDEX-first fallback.
7. After init, confirm `future_plans/INDEX.md` exists. Do not invent initiatives unless the user asks.
8. Surface docs↔code conflicts for user resolution; never silently merge or choose a side.
