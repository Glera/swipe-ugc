# Sort level contracts

This directory is the canonical source for the data-only Sort level contract.
The generator and backend read these files from the pinned `swipe-ugc` checkout;
the runtime build must embed a byte-equivalent copy and verify it against the
golden fixture.

- `sort.runtime-contract.v1.json` is the literal object frozen by ТЗ-2 v2.3.
  Besides board/RNG constants it owns the exact 60 Hz logical clock, integer
  `ceil(milliseconds*60/1000)` conversion, FIFO/phase order, and realtime
  catch-up cap. Changing any of those fields changes `runtimeContractDigest`
  and therefore creates new LevelSpec identities; an old runtime may still be
  retained as an equivalence baseline, but cannot evaluate the new specs.
- `sort.level-spec.v1.schema.json` validates the stored level envelope and all
  JSON-Schema-expressible bounds.
- `RecipeProposal.schema.json` is the only model-authored input. Its defaults
  are materialized by the trusted compiler.
- `RecipeVersion.schema.json` requires every compiled field and has no defaults.
- `generate.mjs` is the pure local `generate(RecipeVersion, seed,
  difficultyTarget)` implementation. It uses only the named `layout` mulberry32
  substream and emits a fully materialized LevelSpec.

`specHash` covers exactly `{schema,runtimeContractDigest,seed,params}`. The
resource-balance check depends on counts across arrays and is therefore enforced
by `contract.mjs` after schema validation.

The generator starts both the cell and target pools with balanced colour counts,
then applies deterministic Fisher-Yates passes. `difficultyTarget` selects the
mixing profile; it is lineage input, not part of the stored LevelSpec. Actual
difficulty and solvability are established later by the versioned oracle gate.

## Pinned runtime roles

- `bases/sort-v2-levels` remains the immutable pre-scheduler equivalence
  baseline. It can detect behavioral drift against the old runtime, but it must
  not be selected for logical-clock/oracle evaluation.
- `bases/sort-v2-levels-qa` is a QA-only build from the exact committed
  playables commit/tree in `generator/baselines.json`. Its descriptor and
  wrapper manifest pin the runtime contract, built artifact digest, and the
  logical scheduler/virtual-clock/oracle capabilities. It is always marked
  `releasePlayable: false` and is not a client runtime pin.

Rebuild and compare it without reading the dirty playables checkout:

```bash
npm run baseline:sort-qa:write  # isolated clone + committed browser source gate
npm run baseline:sort-qa:check  # isolated deterministic rebuild + byte compare
node scripts/runtime-artifact.mjs --verify bases/sort-v2-levels-qa
```

The builder fixes commit, subtree, package-lock digest, installed toolchain,
build environment, and UTC build stamp before running the committed Vite and
post-build transforms. The final command emits only the verified `sha256:…`
digest on stdout so server-side snapshot resolution can fail closed.
