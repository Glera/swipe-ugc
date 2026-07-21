# Merge raster-art vertical v1

This recipe compiles generated raster sources into a separate
`merge-locked-v1-swipe` catalog candidate. It never edits the built-in playable.

- `merge.art-template.v1.json` freezes the pinned gameplay source, nine generated
  source slots, twenty-one compiled runtime slots, three provided static character
  portraits, and the required QA matrix.
- `merge.art-provider-policy.v1.json` caps a supervised world at nine bundled
  image-generation calls and zero marginal API cost. Unknown pricing fails closed.
- `merge.art-source-pack.v1.schema.json` and `contract.mjs` make source identity,
  budget evidence, paths, bytes, dimensions, and digests executable.
- Characters are supplied bytes, not generated content. Spine is forbidden in the
  compiled runtime. Future character motion belongs to a separate SBS-alpha video
  contract with a static WebP fallback.

The trusted compiler is the only component allowed to crop, chroma-key, resize,
encode, adapt imports, and build the pinned playable. Model output is data only.
