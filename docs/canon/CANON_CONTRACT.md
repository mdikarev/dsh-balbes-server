# Canon Contract

## Purpose
Define the files, templates, and structural policies for this canon.

## How agents must use this file
Treat the machine contract as the source of truth for canon structure.

## Naming conventions
- Canon files use UPPERCASE names (e.g. `INDEX.md`, `OVERVIEW.md`) in the canon root and in every subdirectory (`templates/`, ...).
- Exception: `future_plans/` initiative files use lowercase kebab-case with a `pN` prefix (e.g. `p0-skill-context-efficiency.md`); `future_plans/INDEX.md` stays UPPERCASE.
- Directory names are lowercase (e.g. `future_plans/`).
- Prose lives in `.md` files; data/config files may use other extensions (`.json`, `.yaml`).
- Names use ASCII, digits, `-`/`_`; no spaces, no dot beyond the final extension.
- These rules are descriptive guidance; `validate` does not enforce them yet.

## Machine contract
```yaml
schema_version: 1
cli_compat: ">=0.1.0"
skills_stamp: "0.18.0"
sections:
  - id: index
    path: INDEX.md
    role: index
    required: true
    template: INDEX
  - id: overview
    path: OVERVIEW.md
    role: overview
    required: true
    template: OVERVIEW
  - id: architecture
    path: ARCHITECTURE.md
    role: architecture
    required: true
    template: ARCHITECTURE
  - id: glossary
    path: GLOSSARY.md
    role: glossary
    required: true
    template: GLOSSARY
  - id: discrepancies
    path: DISCREPANCIES.md
    role: discrepancies
    required: true
    template: DISCREPANCIES
  - id: contract
    path: CANON_CONTRACT.md
    role: contract
    required: true
    template: CANON_CONTRACT
  - id: future-plans-index
    path: future_plans/INDEX.md
    role: section
    required: true
    template: FUTURE_PLANS_INDEX
templates:
  - id: INDEX
    path: templates/INDEX.md
  - id: OVERVIEW
    path: templates/OVERVIEW.md
  - id: ARCHITECTURE
    path: templates/ARCHITECTURE.md
  - id: GLOSSARY
    path: templates/GLOSSARY.md
  - id: DISCREPANCIES
    path: templates/DISCREPANCIES.md
  - id: CANON_CONTRACT
    path: templates/CANON_CONTRACT.md
  - id: SECTION
    path: templates/SECTION.md
  - id: ENTITY
    path: templates/ENTITY.md
  - id: MODULE
    path: templates/MODULE.md
  - id: DOMAIN_TOPIC
    path: templates/DOMAIN_TOPIC.md
  - id: FUTURE_PLANS_INDEX
    path: templates/FUTURE_PLANS_INDEX.md
  - id: FUTURE_PLAN
    path: templates/FUTURE_PLAN.md
policies:
  max_lines: 400
  max_line_length: 500
  ignore: []
```

## Change policy
Confirm contract changes with the user and run validation after editing.
