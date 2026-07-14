# Sort skin contracts

`sort.skin-spec.v1` is a data-only presentation contract. It maps the six
canonical gameplay color tokens to display colors and selects trusted
procedural renderer variants. It cannot change LevelSpec, geometry, physics,
timing, conveyor paths, difficulty, motion, props, code, or assets.

Identity is `sha256(JCS({schema, skinContractDigest, params}))`. The literal
contract and JSON Schema have no defaults; every accepted skin is complete.
Role colors must preserve at least the canonical palette's minimum pairwise
distance under the exact normal, deuteranopia, and protanopia transforms frozen
in the contract.

`fixtures/manual-skins.v1.json` contains the six manually authored visual
directions. `fixtures/skin-qa-archetypes.v1.json` is generated reproducibly by
`scripts/build-sort-skin-golden.mjs` and pins five immutable LevelSpecs.
`bases/sort-v2-skins-qa` is the content-addressed, non-release runtime used by
the browser matrix. The matrix requires all 30 level/skin pairs to win, keeps
the complete logical report identical across skins, and verifies distinct
rendered frames; it does not publish or activate the runtime.
