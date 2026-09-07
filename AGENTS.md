<!-- doc-canon:start -->
## doc-canon
For design and development, treat `docs/canon/` as the context source of truth. **Scout first — it is mandatory when the index is available:** run `doc-canon scout "<topic>"` and use its generated working-set manifest (ranked paths, contract roles, snippet stubs, verdict hint); scout seeds the code pack automatically when a code index exists, docs-only otherwise. If scout fails closed, build the missing index and retry; only if building fails, fall back to `doc-canon search` / `docs/canon/INDEX.md` and note every read outside a pack (`doc_miss` / `code_miss`). Expand when unsure before deep reads—without inventing structure. `docs/canon/future_plans/` holds directional initiatives for future system shape, not development tasks or checklists. For new or changed behavior, follow **canon-first**: update living canon via `canon-write` (do not edit `docs/canon/**` yourself) → optional project-local spec/plan if large → after substantial canon changes wait for user go-ahead → application code → close with `canon-audit`. Exceptions: pure bugfix with intended behavior unchanged, `code_stale`, non-behavioral edits. On docs↔code divergence, do not silently pick a side; use canon skills / `DISCREPANCIES.md`. During code analysis in a covered language, try `doc-canon code-index search` first; on empty/thin results, read source as evidence and note the miss (`code_miss`).
<!-- doc-canon:end -->

## Development conventions (agents)

Short rule set; full detail lives in `CONTRIBUTING.md`.

**Rigid boundaries**

- dsh is a dependency, not a fork: never edit installed `@deepseek-ai/*` and never bypass
  the dsh core — compose via profile bundles (`dsh.profile.bundles`), `cordis.patch.yml`
  layers, and own bundles/plugins over the standard dsh seams.
- Never edit `docs/canon/**` directly (canon-first workflow above); never commit
  credentials, keys, `.env`, or local dsh state.

**Plugins (dsh/Cordis)**

- Function plugins named-export `name` / `inject` / `Config` / `apply`, with no default
  export; service packages default-export a `Service` subclass; never mix the two (the
  Loader drops the namespace). `Config` carries a `@deepseek-ai/schemastery` schema.
- Dependencies are declared through `inject`; `ctx.<name>` only for injected services;
  optional services read via strict `ctx.get(name)`.
- Registrations are effects: contribute through `ctx.effect()` / `ctx.on()`, every
  registration disposes and is HMR-safe. Waterfall listeners must call `next()`.

**TypeScript & tests**

- Strict TS, ESM only, `.ts` in package-local relative imports; tests live under
  `tests/` (vitest). Product-visible plugins require a REAL-composition test that boots
  a test `cordis.yml` through the Loader/app; mock only external or nondeterministic
  boundaries (LLM provider, network, clock).

**Verification:** run the checks relevant to the change (`pnpm typecheck`, `pnpm lint`,
`pnpm test` …) and report only commands actually executed.

**Server verification handoff**

- The product has a live deployment: a VPS running the `dsh-balbes` profile under
  systemd, and the owner has access to it. Code reaches that server only through
  GitHub `main` → re-running `scripts/install.sh` on the server (`git pull --ff-only`,
  rebuild, profile sync, plugin copy into profile `node_modules`, SPA deploy,
  service restart). The dev workspace is not the server.
- The canonical operational commands for the server live in
  `docs/runbooks/stage2-vps.md` (install, update, smoke, DoD, troubleshooting) and in
  the installer's own summary. A functional change that affects the server surface
  updates that runbook in the same commit (per CONTRIBUTING: docs change with the
  behavior).
- After finishing any functional change (or whenever the owner asks), hand over
  **server verification instructions** grounded in the runbook: the update command
  (re-run install.sh on the server) plus the API/disk/UI smoke steps for the changed
  surface, each with expected output. Local unit/REAL tests alone are not the full
  verification story.
- Before the owner can verify, changes must be on `origin/main`; pushing a shared
  branch requires the owner's go-ahead.
- Do not assume agent-side server access; give commands the owner runs and offer to
  interpret the output.



