# Canon Index

## How to use this canon

Canon в `docs/canon/` — источник истины для проектирования и разработки в этом
репозитории. При работе над темой сначала выполняется
`doc-canon scout "<topic>"` (обязателен, когда индекс собран) и используется
выданный рабочий набор; canon редактируется только через скиллы canon-*
(`canon-write` и др.), не вручную. За пределами canon действуют рамки
CONTRIBUTING.md и правила AGENTS.md/CLAUDE.md.

## Reading order

1. OVERVIEW.md — зачем проект, scope, сигналы успеха.
2. ARCHITECTURE.md — слои, компоненты, потоки, границы.
3. ADMIN_UI.md — общее направление внешнего вида админки (стиль/дизайн).
4. GLOSSARY.md — термины (профиль, бандл, патч, host, headless и др.).
5. CANON_CONTRACT.md — структура canon и шаблоны секций.
6. DISCREPANCIES.md — открытые/закрытые расхождения.
7. future_plans/INDEX.md — направленные инициативы будущего (не задачи).

## Sections

| id | path | role | required |
| --- | --- | --- | --- |
| index | INDEX.md | index | true |
| overview | OVERVIEW.md | overview | true |
| architecture | ARCHITECTURE.md | architecture | true |
| glossary | GLOSSARY.md | glossary | true |
| admin-ui | ADMIN_UI.md | section | true |
| discrepancies | DISCREPANCIES.md | discrepancies | true |
| contract | CANON_CONTRACT.md | contract | true |
| future-plans-index | future_plans/INDEX.md | section | true |

## Discrepancies

Расхождения canon ↔ код/доки фиксируются в DISCREPANCIES.md и резолвятся через
`canon-audit`. Сейчас открытых расхождений нет.
