#!/usr/bin/env python3
"""Deterministically normalize a validated Merge art source pack.

Chroma removal happens before this compiler through the imagegen skill's
remove_chroma_key.py. This stage only fits opaque backgrounds, crops alpha
cutouts, splits fixed-grid progression sheets, and writes WebP runtime slots.
"""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

from PIL import Image, ImageOps


RESAMPLE = Image.Resampling.LANCZOS
WEBP_OPTIONS = {"format": "WEBP", "quality": 90, "method": 6, "exact": True}


def fail(message: str) -> None:
    raise RuntimeError(message)


def save(image: Image.Image, output: Path, *, alpha: bool) -> dict:
    output.parent.mkdir(parents=True, exist_ok=True)
    converted = image.convert("RGBA" if alpha else "RGB")
    converted.save(output, **WEBP_OPTIONS)
    payload = output.read_bytes()
    return {
        "path": output.name,
        "sha256": sha256(payload).hexdigest(),
        "bytes": len(payload),
        "width": converted.width,
        "height": converted.height,
        "alpha": alpha,
    }


def background(source: Path, output: Path, width: int, height: int) -> dict:
    with Image.open(source) as raw:
        image = ImageOps.fit(raw.convert("RGB"), (width, height), method=RESAMPLE, centering=(0.5, 0.5))
    return save(image, output, alpha=False)


def cutout_image(raw: Image.Image, width: int, height: int) -> Image.Image:
    image = raw.convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        fail("transparent source has no visible subject")
    transparent = sum(1 for value in alpha.getdata() if value < 8)
    if transparent < image.width * image.height * 0.04:
        fail("transparent source has less than 4% transparent pixels; chroma removal is unproven")
    subject = image.crop(bbox)
    limit_w = max(1, round(width * 0.84))
    limit_h = max(1, round(height * 0.84))
    subject.thumbnail((limit_w, limit_h), RESAMPLE)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.alpha_composite(subject, ((width - subject.width) // 2, (height - subject.height) // 2))
    return canvas


def cutout(source: Path, output: Path, width: int, height: int) -> dict:
    with Image.open(source) as raw:
        image = cutout_image(raw, width, height)
    return save(image, output, alpha=True)


def sheet(source: Path, output: Path, *, chain: int, count: int, columns: int, rows: int, width: int, height: int) -> list[dict]:
    with Image.open(source) as raw:
        image = raw.convert("RGBA")
        cell_w = image.width // columns
        cell_h = image.height // rows
        if cell_w < 1 or cell_h < 1:
            fail(f"chain {chain} sheet has invalid grid")
        results = []
        for index in range(count):
            column = index % columns
            row = index // columns
            cell = image.crop((column * cell_w, row * cell_h, (column + 1) * cell_w, (row + 1) * cell_h))
            normalized = cutout_image(cell, width, height)
            target = output / f"chain-{chain}-level-{index + 1:02d}.webp"
            results.append(save(normalized, target, alpha=True))
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    root = Path(args.pack_root).resolve()
    output = Path(args.out).resolve()
    manifest = json.loads(Path(args.manifest).read_text())
    template = json.loads(Path(args.template).read_text())
    slots = template["compiledSlots"]
    sources = manifest["sources"]

    def source(name: str) -> Path:
        candidate = (root / sources[name]["path"]).resolve()
        if root not in candidate.parents:
            fail(f"{name} escapes pack root")
        return candidate

    files: dict[str, dict] = {}
    spec = slots["backgroundPortrait"]
    files["backgroundPortrait"] = background(source("backgroundPortrait"), output / "background-portrait.webp", spec["width"], spec["height"])
    spec = slots["backgroundLandscape"]
    files["backgroundLandscape"] = background(source("backgroundLandscape"), output / "background-landscape.webp", spec["width"], spec["height"])
    for key, output_name in [("generator", "generator.webp"), ("lockStage1", "lock-stage-1.webp"), ("lockStage2", "lock-stage-2.webp")]:
        spec = slots[key]
        files[key] = cutout(source(key), output / output_name, spec["width"], spec["height"])
    for chain in range(1, 5):
        source_key = f"chain{chain}Sheet"
        source_spec = template["generatedSources"][source_key]
        target_spec = slots[f"chain{chain}"]
        files[f"chain{chain}"] = sheet(
            source(source_key), output, chain=chain, count=target_spec["count"],
            columns=source_spec["columns"], rows=source_spec["rows"],
            width=target_spec["width"], height=target_spec["height"],
        )

    print(json.dumps({"schema": "merge.art-normalization-result.v1", "files": files}, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"merge_art_normalization_failed: {error}", file=sys.stderr)
        raise SystemExit(1)
