---
name: canon-audit
description: Audit canon semantics, resolve divergence, and maintain discrepancy state.
---

# Canon Audit

## Safety and source of truth

- The source of truth (SoT) is `docs/canon/`; start from `docs/canon/INDEX.md`.
- Never modify application code. Edit only `docs/canon/**`; managed paths may be changed only by CLI upgrade flows.
- Always run `doc-canon validate --json` before claiming success on canon edits; success requires exit 0 and zero `error`-severity issues.
- Keep prose and list lines within the contract's `policies.max_line_length` (default 500 chars); wrap long lines into continuation lines instead of single walls of text. Table rows and fenced code blocks are exempt (table rows cannot be wrapped).
- If `doc-canon` is missing on PATH, stop and give an install hint: `npm install -g doc-canon` or use a local npx invocation. Do not continue without validation.

## Audit flow

1. Run `doc-canon validate --json` first. If it fails (exit ≠0 or `error`-severity issues), stop the semantic pass and repair structure through canon-write or the contract through canon-contract.
2. Run `doc-canon check` to refresh the language-agnostic inventory and CLI findings (Scout inputs).
3. **Try scout first:** ensure the indexes are built — hint `doc-canon index` when the canon index is missing, and when covered source is in scope for code-divergence evidence, `doc-canon code-index build`. Then run `doc-canon scout "<topic>"` and use the returned working-set manifest (ranked paths with contract roles, snippet stubs, verdict hint); scout seeds the code pack automatically when a code index exists, else it is docs-only. If scout fails closed, run `doc-canon index` (and `code-index build` when covered source is in scope), then re-run scout; only if building fails, fall back to INDEX-first Scout and record `doc_miss: <query> -> docs:<path>` for every file read outside the pack. Scout/search failure alone never licenses INDEX-first fallback. If `index_stale`, surface the warning and continue; Expand when thin.
4. **Scout:** from scout results (or `INDEX.md` fallback), contract, fresh inventory/report, build a working-set manifest (`path`, `role`, short free-form `stub`). Include likely evidence paths for claims you will make. Do not preload every markdown file.
5. **Expand gate:** briefly show the working set (paths + stubs) and verdict **sufficient** or **need more** (which paths, why). Doubt → expand until claims can be evidence-backed. Free-form brevity; multiple expands are fine; silent under-read is not.
6. Only after **sufficient**, deep-read the approved set (inventory, report — apply Open findings for LLM context, canon, and code evidence paths). Do not rely on model memory.
7. Perform the semantic checks:
   - coverage of required contract paths and INDEX entries;
   - orphans, while recognizing the CLI already checks them;
   - glossary terms against inventory/text hits or explicit doc-only evidence;
   - architecture claims against inventory paths;
   - relative and Related-canon links;
   - doc↔doc conflicts only when supported by at least two cited passages.
   - Do not treat `future_plans` prose as the current behavioral SoT when judging docs↔code drift; it is directional canon for future system shape.
8. Every finding must cite canon paths and inventory/code paths, or explicitly say code is missing. Deduplicate normalized kind/path sets and honor all ignores.

## Open findings for LLM context

During Scout → Expand → semantic deep-read, keep report evidence in the model context to **open** findings only (`status: open`, both `source: cli` and `source: skill`). Do not paste or paraphrase `status: stale` finding bodies into the reasoning transcript. A single compact note is allowed: `stale_skipped: N` (count only). Prefer filtering `doc-canon report` / report JSON to an open-only view for judgement; do not `Read` the full `.doc-canon/report.json` just to “understand the picture.”

After write-back, when summarizing to the user, default to open findings; mention stale only as a count or if the user asks.

Full `doc-canon report` (all statuses) is still required at the merge step under **Report ownership**—open filtering must not skip prior skill discovery or stale marking.

## Report ownership

After the semantic pass, before writing `.doc-canon/report.json`:

1. Run `doc-canon report` and collect every finding with `source: skill` as **prior**.
2. Match this audit's confirmed findings to prior by normalized `(kind, paths)`.
3. On match: keep the same `F-NNN`, set `status: open`, update summary/evidence as needed.
4. Prior with no match (this audit did not reproduce it): set `status: stale`; do not delete or resolve them.
5. Confirmed with no prior: assign a new `F-NNN` from the greatest existing id.
6. Read-modify-write the report: emit updated skill findings (each with `source: skill`) plus every `source: cli` finding unchanged. Never replace the other source's findings.

`structure` and `consistency` findings are not filed into `DISCREPANCIES.md`. Repair them through validate, canon-write, or canon-contract. Only grounded `conflict` and `drift` findings enter the discrepancy dialogue.

## Resolve dialogue and discrepancy lifecycle

1. Present evidence and ask the user whether docs or code are stale. Never silently choose.
2. Before adding an Open entry, deduplicate by overlapping canon/code paths. Assign a new `D-NNN` from the greatest existing ID and never reuse IDs. A new unresolved entry has `decision: pending`.
3. Follow this strict order: successful apply → set the decision → then move Open → Resolved when appropriate. If apply is interrupted or validation fails, leave `decision: pending`.
4. For `docs_stale`, edit the canon from its template and run `doc-canon validate --json`. Only after it succeeds, set `decision: docs_stale`, then move the entry to Resolved in the same session.
5. For `code_stale`, write or update the Open discrepancy task and its `coding_agent_prompt` first. Include what to study, what diverges, evidence paths, and questions requiring user clarification. Only after that write succeeds, set `decision: code_stale`. It must stay Open until a later audit confirms the code no longer diverges; only that later audit may move it to Resolved.
6. A later audit may also move a linked Open entry to Resolved when its conflict no longer reproduces and docs validate. `doc-canon check` itself never edits `DISCREPANCIES.md`.

Finish by running `doc-canon validate --json` again after any canon edits and report remaining open decisions.
