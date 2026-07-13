# Sort level gate: golden smoke

From the `swipe-ugc` repository root, run the canonical seed through the same
pinned Playwright gate used by level QA:

```bash
node worker/level-gate.mjs --golden 137
```

The command accepts only seeds present exactly once in
`recipes/sort/levels/fixtures/sort-contract-golden.v1.json`. It resolves the
fixture's validated RecipeVersion and LevelSpec, then pins
`sort-v2-levels-qa` from `generator/baselines.json` plus its immutable
manifest. The single stdout line is compact JSON and deliberately excludes
timing such as `mountMs`; `runtimeArtifactDigest` uses the `sha256:` wire form,
while `runtimeContractDigest` is a bare lowercase digest.

The seed is only a fixture lookup key, not level identity. Always report the
returned `fixture` and `specHash` with the metrics: a generated LevelSpec may
use the same seed while having a different map, target stacks and terminal
tick.

Exit codes:

- `0`: the trusted gate returned `pass`.
- `2`: the gate completed but returned `inconclusive` or `flake`.
- `1`: input, fixture, pin, browser, protocol, or other infrastructure error.
