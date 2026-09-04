---
name: canon-write
description: Author, refactor, and synchronize canon documentation.
---

# Canon Write

## Safety and source of truth

- The source of truth (SoT) is `docs/canon/`; start from `docs/canon/INDEX.md`.
- Never modify application code. Edit only `docs/canon/**`; managed paths may be changed only by CLI upgrade flows.
- Always run `doc-canon validate --json` before claiming success on canon edits; success requires exit 0 and zero `error`-severity issues.
- Keep prose and list lines within the contract's `policies.max_line_length` (default 500 chars); wrap long lines into continuation lines instead of single walls of text. Table rows and fenced code blocks are exempt (table rows cannot be wrapped).
- If `doc-canon` is missing on PATH, stop and give an install hint: `npm install -g doc-canon` or use a local npx invocation. Do not continue without validation.

## Called before feature code

Coding agents updating **behavior or public contract** must invoke this skill (or ask the user to run it) **before** application-code changes for that feature. They must not edit `docs/canon/**` themselves. After a **substantial** write, the coding agent should wait for explicit user go-ahead before implementing; spot sync may proceed. Pure bugfix / `code_stale` / non-behavioral work are exceptions to that canon-first order (see pointer rule).

## Scout → Expand before deep reads

Before deep-reading canon file bodies or drafting substantial SoT changes:

1. **Mandatory probe:** run `doc-canon scout "<topic>"` and use the returned working-set manifest (ranked paths with contract roles, snippet stubs, verdict hint); scout seeds the code pack automatically when a code index exists, else it is docs-only. The agent keeps the semantic Expand decision — `need_more` triggers Expand; `sufficient` still allows Expand on doubt. Do not dump all canon markdown.
2. **If scout fails closed** (missing/corrupt index): run `doc-canon index` (and `code-index build` when covered source exists), then re-run scout. Only if building fails, continue with INDEX-first progressive disclosure (`docs/canon/INDEX.md`; select only relevant rows) and record `doc_miss: <query> -> docs:<path>` for every file read outside the pack. Scout/search failure alone never licenses INDEX-first fallback.
3. **If search returns `index_stale`:** the CLI self-heals when no watch owns the index; with a live watch, surface the warning, continue with the pack, and Expand when evidence feels thin.
4. **Expand gate:** briefly show the working set (paths + stubs) and a verdict **sufficient** or **need more** (which paths, why). Free-form brevity is fine. Doubt → expand; multiple expands are fine; silent under-read is not.
5. Only after **sufficient**, deep-read the approved set and continue the Workflow.

Use `doc-canon check` inventory/report only when syncing against the tree/code. Open `CANON_CONTRACT.md` / templates only when structure, a new kind, or a write template is needed.

## Clarify before substantial writes

After Scout → Expand (and any further expands), before any **substantial** edit under `docs/canon/**` (new meaning, invariant change, behavioral claim, or non-trivial factual sync), apply this gate if invent-risk remains. Do **not** invent material facts to fill gaps. Do **not** run this gate before Scout.

**Skip** when the user request already supplies the facts or decisions needed to write honestly. Say briefly that clarify is unnecessary, then continue the Workflow.

**Otherwise**, ask at most **three** clarifying questions, **one at a time**:

1. Ask a single decision-axis question.
2. Offer options **A/B/C** (optional **D** = other / freeform).
3. State the **recommended** option and one sentence why.
4. Wait for the answer before asking another question.
5. Ask another only if writing would still require inventing a material fact.

If the user declines to choose or says to proceed without answering, take the **recommended** option, say so briefly, and write.

The existing docs↔code “which side is stale?” question uses this same options+recommendation format and **counts toward the three** when it runs in the same pre-write gate.

Clarify does **not** replace the contract workflow: for a new kind or structural change, stop and invoke `canon-contract` after intent is clear.

## Documentation coverage checklist

Canon sections are living behavioral SoT. When authoring or refactoring a section, cover each required content category below, or explicitly exclude it in that section's Scope with a reason. This is an authorship discipline, not validator-enforced structure; keep the registered template's required headings and add coverage as the section's key details / responsibilities / flows call for.

- **Public interfaces** — public inputs, outputs, and contracts; observable signals (exit codes ≠0, warnings, `--json` shape)
- **Workflows / key flows** — order of steps for each main operation
- **Usage examples** — working command examples with flags and expected results
- **Operational runbooks** — startup, configuration, upgrade, rollback, recovery
- **Failure modes / error handling** — what can break, how failure is signaled, how to recover
- **Success criteria** — observable signs that the system works as documented

## Workflow

1. Run **Scout → Expand before deep reads** (show working set + verdict). Prefer expand over loading the whole canon when affected sections are unclear.
2. After Expand, apply **Clarify before substantial writes** when invent-risk remains. Skip clarify when the request already supplies the needed facts; say briefly that clarify is unnecessary.
3. Deep-read only the approved working set: `INDEX.md`, and as needed `CANON_CONTRACT.md`, affected sections, and their registered templates.
4. Author or refactor only from registered templates. Preserve required headings; extra headings are allowed.
5. For a new kind or structural change, stop and invoke the contract workflow. Do not invent files, section kinds, or template structures.
6. During everyday sync, update affected sections and `INDEX.md` as needed, and keep cross-links consistent.
7. If canon and code diverge, ask the user which side is stale. Never edit application code. Record code work through `DISCREPANCIES.md`.
8. Do **not** create or refine initiatives, or edit `future_plans/**` for status/INDEX sync — stop and tell the user to run `canon-future-plan`.
9. When absorbing a finished initiative, update living SoT sections only, validate, then instruct the user to run `canon-future-plan` to mark it `absorbed` and sync `future_plans/INDEX.md`.
10. Validate after edits by running `doc-canon validate --json`. Claim success only after it passes.
11. After any successful **substantive** write to `docs/canon/**`, run one-shot `doc-canon index`. If a watch holds the index lock, surface the failure and rely on the watch or suggest `doc-canon index --stop`; do not reindex inside `search`.
12. A docs-stale discrepancy may move from Open to Resolved in this session only after the canon fix validates. A code-stale entry remains Open until a later audit confirms that code has aligned.
