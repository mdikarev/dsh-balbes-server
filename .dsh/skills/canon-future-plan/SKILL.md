---
name: canon-future-plan
description: Author and refine directional future-plans initiatives and keep future_plans/INDEX.md in sync.
---

# Canon Future Plan

## Safety and source of truth

- The source of truth (SoT) is `docs/canon/`; start from `docs/canon/INDEX.md`.
- Never modify application code. Edit only `docs/canon/future_plans/**`; managed paths may be changed only by CLI upgrade flows.
- Always run `doc-canon validate --json` before claiming success on canon edits; success requires exit 0 and zero `error`-severity issues.
- Keep prose and list lines within the contract's `policies.max_line_length` (default 500 chars); wrap long lines into continuation lines instead of single walls of text. Table rows and fenced code blocks are exempt (table rows cannot be wrapped).
- If `doc-canon` is missing on PATH, stop and give an install hint: `npm install -g doc-canon` or use a local npx invocation. Do not continue without validation.

## Scope

This skill owns `docs/canon/future_plans/**`: creating and refining directional initiatives, status changes, and keeping `future_plans/INDEX.md` in sync. Initiatives are **not** behavioral source of truth for current behavior — they describe future system shape only. It does not edit living canon sections (that is `canon-write`) and it does not register new contract section kinds or templates (that is `canon-contract`).

## Scout → Expand before deep reads

Before drafting or refining an initiative:

1. **Try search first (optional):** run `doc-canon search "<topic>"` when cross-canon context helps; seed stubs from pack paths/snippets. On fail-closed, hint `doc-canon index` and continue with the narrow set below.
2. **Progressive disclosure:** build a narrow working set — `future_plans/INDEX.md`, the target initiative file (if refining), and `templates/FUTURE_PLAN.md`. Do not preload the rest of the canon.
3. **Scout:** note `path`, `role`, and a short free-form `stub` for each item in the working set. Do not invent structure.
4. **Expand gate:** briefly show the working set and a verdict — **sufficient** or **need more** (which paths, why). Doubt → expand; silent under-read is not acceptable.
5. Only after **sufficient**, deep-read the approved set and continue the Workflow.

## Clarify before invent

After Scout → Expand, if invent-risk remains before writing or refining an initiative, apply this gate (same protocol shape as `canon-write`):

1. Ask a single decision-axis question (e.g., new vs. refine, `pN` id/slug, priority order, status).
2. Offer options **A/B/C** (optional **D** = other / freeform).
3. State the **recommended** option and one sentence why.
4. Wait for the answer before asking another question.
5. Ask up to **three** questions total, one at a time, only while writing would still require inventing a material fact.

**Skip** when the request already supplies the facts needed to write honestly; say briefly that clarify is unnecessary. If the user declines to choose or says to proceed without answering, take the recommended option, say so briefly, and write.

## Workflow

1. Run **Scout → Expand before deep reads** (show working set + verdict).
2. Apply **Clarify before invent** when invent-risk remains for id, slug, table order, or status.
3. Propose an id (`pN`, or `pN` plus a letter suffix when interleaving), a filename slug, the Initiatives table position, and the initial status — `draft` for a new initiative, or the current status when refining.
4. Author or refine the file from `templates/FUTURE_PLAN.md`, preserving its required headings (`Intent`, `In scope`, `Out of scope`, `Absorbs into`, `Open questions`). Established metadata bullets such as Status / Focus / Depends / Unblocks / Design are allowed.
5. Update the `future_plans/INDEX.md` Initiatives table (columns `| # | Initiative | Status | File |`): add or update the row (file, status), keep table order reflecting priority, and add a short ordering note under the table when priority changes.
6. Refuse checklists, sprint plans, task-tracker content, and coding-agent prompts inside initiative bodies; point the user to a roadmap, issue tracker, or `DISCREPANCIES.md` instead.
7. Do not edit `CANON_CONTRACT.md`'s section list for a new initiative — initiative files are not registered per-file; only the `future-plans-index` section and the `FUTURE_PLAN` / `FUTURE_PLANS_INDEX` templates are contract-registered. If a genuinely new template kind is needed, stop and invoke `canon-contract`.
8. Never edit application code or living canon sections outside `future_plans/`.
9. Run `doc-canon validate --json`; claim success only after it passes (exit 0, zero `error`-severity issues).

## Absorb handoff

When an initiative's outcomes have already shipped and the user asks only to update its status:

1. Confirm the relevant living canon sections were already updated (via `canon-write`). If they were not, stop and tell the user to run `canon-write` first to absorb outcomes into living SoT — this skill does not rewrite living canon sections.
2. Set the initiative's status to `absorbed` (or the project's local terminal label) and update its `future_plans/INDEX.md` row.
3. Run `doc-canon validate --json` and claim success only after it passes.

## Status vocabulary

`draft` → `refining` → `implementing` → `absorbed` (projects may add local labels; do not turn `future_plans/` into a task tracker).
