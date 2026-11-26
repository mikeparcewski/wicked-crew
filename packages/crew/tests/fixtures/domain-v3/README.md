# domain-v3 fixtures (J6 K1)

Real-shape fixtures: each file is a product route's own output, not a hand-written document.

| File | Writer | How it was made |
|---|---|---|
| `model-built.json` | wicked-core `domain-graph --out` (wicked-core PR 1922 head `d2437d7`, `crates/wicked-governance/src/domain_extract.rs` `build_model`) | core's `tests/fixtures/domain_v3/mini-cobol.sql` loaded with `sqlite3` as the store, and a copy of `tests/fixtures/domain_v3/mini-cobol/` as the checkout |
| `model-cert.json` | wicked-core `domain-graph --out`, built from the wicked-core garden#1545 branch (`crates/wicked-governance/src/domain_extract.rs` `build_extract_model`: only a statement a shown business sentence cites is a requirement; the rest are `metadata.statements`) | core's `tests/fixtures/domain_v3/mini-cobol-cert.sql` (garden's real route over `mini-cobol` in the train-16 J6 cert's shape, `gen/gen_cert.py`) loaded with `sqlite3` as the store, and a copy of `tests/fixtures/domain_v3/mini-cobol/` as the checkout |
| `model-after-rulings.json` | the same `domain-graph --out`, after the three saved rulings in `rulings.json` | same store and checkout |
| `rulings.json` | wicked-core `domain-ruling` (same binary): `command`, exit code and the one JSON line it printed (`stdout`) | each call also took `--db <store> --repo-root <checkout>` (left out of `command`); `Core.domainRuling` answers the same line |
| `scope-mini-cobol.json` | wicked-garden `scripts/domain/scope.py` (garden main `2b4066d7`) | `--root <core>/tests/fixtures/domain_v3/mini-cobol --db <the store after the rulings> --scope '{"intent": "How PAYCALC1 computes pay from the payroll file"}'` |

The same model, as built, is the schema fixture wicked-garden PR 1578 adds (`skills/domain/refs/fixtures/core-1.2.0-mini-cobol.json`; not on garden main until it merges).
