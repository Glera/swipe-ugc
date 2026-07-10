# swipe-ugc

Hosting repo for **player-generated mechanics** (the island meta, triangle tab in
the feed). Deliberately separate from `swipe-platform`: that repo is the
git-deployed first-party artifact; this one receives runtime UGC commits from
the bake worker and is served as a static site (Render). A separate origin also
sandboxes UGC code away from the platform's localStorage/session.

Everything under `u/` is a generated artifact — do not hand-edit.

Full system documentation for the island meta (concept, flows, all four repos,
TODOs): `feed-prototype/ISLAND.md` in the workspace.

## Layout

```
u/<user>/<slug>-<hash8>.html          baked fork (shell)
u/<user>/<slug>-<hash8>.payload.js    baked fork (payload with the theme applied)
u/<user>/<slug>-<hash8>.meta.json     immutable size/cost metadata for the platform
worker/bake.mjs                       recipe → bake → test → publish → notify
recipes/sort/                         canonical recipe, constraints, AI prompt
```

The content hash in the filename makes every artifact immutable: a new version
is a new file, caches never need busting (same trick as `versions.json` on the
platform, for free).

## Worker

```bash
node worker/bake.mjs --pack '<theme-pack json>' --prompt 'затерянная атлантида' --user dev
```

Pipeline: read the base build (`playables/marble-sort-swipe/dist-swipe`), inject
the versioned visual/gameplay variant config, write the fork under `u/<user>/`,
**autoplay it to WIN in headless chromium**, then `git commit` + `push`, then
notify the player via the Telegram bot. The config controls difficulty, motion,
scene surfaces, marble treatment, source/target shapes, conveyor path, and
background pattern; its seed makes a published artifact reproducible.

`recipes/sort/` is the source of truth for the base build, source palette, pack
constraints, and AI theme prompt. Both the worker and feed Vite config use
`recipe.mjs`; the Python backend reads the same JSON/text files at runtime.
Production `RESULT` is emitted only after both artifact files are verified in
the remote branch. A local commit left by a failed push is retried on the next
identical bake instead of being mistaken for a published artifact.

In dev the worker is invoked automatically by the feed dev server only after a
player confirms/builds the mechanic (`feed-prototype/vite.config.ts` →
`islandThemeApi`). Preview and reroll generate theme packs only; they do not
publish artifacts.

### Env

| Var | Meaning |
|---|---|
| `UGC_TEST_TIMEOUT_SEC` | Full autoplay WIN timeout. Defaults to 180 seconds; values below 30 are clamped. |
| `UGC_DRY_RUN=1` | Bake and run the full WIN gate, then remove generated artifacts without committing or pushing. |
| `UGC_NO_PUSH=1` | Commit locally, skip `git push`. |
| `PLAYABLES_ROOT` | Root containing `marble-sort-swipe/dist-swipe`. Defaults to sibling `../playables` in the local workspace. |
| `BOT_TOKEN` | Telegram bot token (same var name as swipe-bot). Notification is skipped (and logged) when absent. |
| `UGC_NOTIFY_CHAT_ID` | Chat to notify. Get yours: send `/start` to the bot, then `curl https://api.telegram.org/bot$BOT_TOKEN/getUpdates` → `message.chat.id`. |
| `UGC_BASE_URL` | Public base URL of this repo's static site (e.g. `https://swipe-ugc.onrender.com`). Used in the notification link. |

## Hosting (Render)

`render.yaml` describes a free static site. Connect this repo in the Render
dashboard once; every worker push auto-deploys (~1 min). When volume outgrows
git-as-storage, the worker's publish step swaps to S3/R2 — nothing else changes.

## Privacy (planned change)

This repo is **public for the prototype phase only** — acceptable because the
static site serves the same files publicly anyway, and a public repo gives a
free backup CDN (jsDelivr). The product decision is to eventually **hide
generated mechanics**: players' creations are product content and should not be
browsable/scrapable outside the platform. Target setup: a **closed CDN** —
private bucket (S3/R2) with delivery through non-public or signed URLs and no
listing; this repo goes private or is replaced by object storage entirely. Only
the worker's publish step changes; bake, testing, and notification stay as-is.

## Production notes

This worker runs on the dev machine as a rehearsal of the real pipeline. The
production version is the same steps on a backend worker: theme via API (not
subscription CLI), bake, the same playwright gate, upload, bot push with a
`t.me/<bot>/<app>?startapp=island` deep link.
