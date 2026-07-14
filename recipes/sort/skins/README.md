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
