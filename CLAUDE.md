<!-- doc-canon:start -->
# doc-canon context rule

For design and development, the context source of truth is `docs/canon/`. Run `doc-canon scout "<topic>"` first when the index is available and use its generated working-set manifest (ranked paths, contract roles, snippet stubs, verdict hint); scout seeds the code pack automatically when a code index exists, docs-only otherwise. If scout fails closed because the index is missing or corrupt, run `doc-canon index` (and `code-index build` when covered source exists), then re-run scout. Only if building fails, fall back to `doc-canon search` / `docs/canon/INDEX.md` and note every read outside a pack (`doc_miss: <query> -> docs:<path>` / `code_miss: <query> -> source:<path>`). Expand when unsure; do not silently under-read or invent structure. `docs/canon/future_plans/` holds directional initiatives for future system shape, not development tasks or checklists.

## Scout-first is mandatory

The scout manifest is the required first context probe when an index is available. The agent keeps the semantic Expand decision: `need_more` requires expanding the working set, while `sufficient` still allows expansion on doubt. If scout fails closed after the build-and-retry path, use INDEX-first progressive disclosure only as the documented fallback.

## Feature-change order (canon-first)

For **new or changed functionality** (behavior / public contract), do **not** start application code first. Order:

1. Update living canon via **`canon-write`** (coding agents must not edit `docs/canon/**` themselves).
2. Optionally write a project-local design/plan for large changes.
3. After substantial canon changes, wait for explicit user go-ahead before coding.
4. Implement application code against the updated canon.
5. Close with **`canon-audit`** on the affected topic.

Exceptions: pure bugfix with intended behavior unchanged, `code_stale`, and non-behavioral edits. On docs↔code divergence, do not silently pick a side; escalate through canon skills and `docs/canon/DISCREPANCIES.md`.

## Code analysis order

For TypeScript/JavaScript, Go, C#, Rust, or Python, try `doc-canon code-index search <symbol> --root <repo>` before reading whole source files. Use bounded snippet windows first. When the result is empty or thin, read source as evidence and note `code_miss: <query> -> source:<path>`; a stale warning does not license bypassing the pack.

This rule sets context priority; it does not replace other domain rules in the repository.
<!-- doc-canon:end -->
