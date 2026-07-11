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
bases/sort-v2/                        immutable guided-generator build (never release)
preview/sort-v2.html                  config-in-hash candidate preview shell
generator/baselines.json              pinned source commit/tree for free experiments
worker/hardening.mjs                  enforced CSP + Playwright network deny
```

The content hash in the filename makes every artifact immutable: a new version
is a new file, caches never need busting (same trick as `versions.json` on the
platform, for free).

## Worker

```bash
node worker/bake.mjs --pack '<theme-pack json>' --prompt 'затерянная атлантида' --user dev
```

Pipeline: verify and read the frozen generator build (`bases/sort-v2`), inject
the versioned visual/gameplay variant config, write the fork under `u/<user>/`,
**autoplay it to WIN in headless chromium**, then `git commit` + `push`, then
notify the player via the Telegram bot. The config controls difficulty, motion,
scene surfaces, marble treatment, source/target shapes, conveyor path, and
background pattern; its seed makes a published artifact reproducible.

`recipes/sort/` is the source of truth for the generator base, source palette,
pack constraints, and AI theme prompt. The frozen base manifest records file
hashes and is explicitly marked `releasePlayable: false`; bake refuses any hash
mismatch. The Python backend reads the same recipe JSON/text files at runtime.
Production `RESULT` is emitted only after both artifact files are verified in
the remote branch. A local commit left by a failed push is retried on the next
identical bake instead of being mistaken for a published artifact.

In dev the guided worker is invoked only after a player confirms/builds the
mechanic. Preview and reroll generate theme packs only; they do not publish
artifacts. Neither guided bake nor its production runtime reads, builds, or
mounts the release `playables` checkout.

### Local creative-experiment lab

The third/high-cost candidate is deliberately dev-only. A separate persistent
`swipe-generator` service asks a local Claude Code or Codex subscription for
three concepts, then starts `worker/experiment.mjs` for the selected one. Every
job names a baseline in `generator/baselines.json`; the worker resolves that
exact commit and verifies its exact tree before creating a disposable detached
clone with its own refs and object store. It never uses a branch or
`playables/HEAD`, and it never commits or pushes to `playables`. The agent can
touch only `marble-sort-swipe/src/*.ts` in that disposable clone and has no
network access. The outer worker rejects a changed clone `HEAD`, forbidden
paths/capabilities/dependencies, patches smaller than 20 changed lines, new
TypeScript diagnostics in changed files, oversized payloads, build failures,
and runtime/security conformance failures. The self-contained artifact receives
a network-deny CSP and Playwright aborts every non-local request. Browser checks
cover staged readiness, pause, manual input, 30-second idle stability, fixed-seed
autoplay, non-instant completion, visible frame changes, and rAF health.

An inconclusive physics autoplay is rerun once on the exact same build before a
new model call. A healthy/runtime-safe build whose win is still unproven may be
shown and tuned locally with `autoplayPassed:false`; publication remains strict
WIN-only. Up to three hard repair passes share one 24-hour job budget. A living,
silent agent is not killed: five-minute PID/output/file-edit heartbeats remain
visible as structured `agent`/`quiet` liveness, and only an observed process exit
or the explicit day deadline can consume an attempt.

The lab strips Anthropic and OpenAI API variables from concept and coding
subprocesses. It uses local CLI subscription logins and cannot silently fall
back to API credentials inherited by either service.

Successful artifacts live under ignored `u/local-experiments/`; lineage patches
and manifests live under ignored `.local-experiments/`. Generator job state is
persisted under `swipe-generator/.data`, so a Vite/page reload does not stop or
lose work and the platform reconnects to unfinished jobs. Artifacts are served
by Vite, can be tuned with another natural-language patch, and are not published
during generation. The UI is absent from production builds. A placed experiment
is kept in a separate local overlay store, so later island syncs cannot upload
its URL or replace backend state.
When `BOT_TOKEN` and a TMA chat id (or `UGC_NOTIFY_CHAT_ID`) are available, the
detached runner notifies the player on ready/final failure even if the page is closed.

Explicit **Publish tested artifact** runs `worker/publish-experiment.mjs`. It
repeats sandbox autoplay, creates a detached worktree from `origin`, verifies a
two-path commit allowlist (`.html` + `.meta.json`), pushes that commit, and polls
the immutable Render URL. The source patch remains ignored and no `playables`
file is copied or committed. Model execution still happens only through the
local subscription; publication does not call the Anthropic API.

### Env

| Var | Meaning |
|---|---|
| `UGC_TEST_TIMEOUT_SEC` | Full autoplay WIN timeout. Defaults to 180 seconds; values below 30 are clamped. |
| `UGC_DRY_RUN=1` | Bake and run the full WIN gate, then remove generated artifacts without committing or pushing. |
| `ISLAND_EXPERIMENT_MODEL` | Claude Code model for the local free experiment. Defaults to `sonnet`; set `opus` for slower, wider exploration. |
| `ISLAND_EXPERIMENT_EFFORT` | Claude Code reasoning effort for implementation. Defaults to `medium`; accepts `low/medium/high/xhigh`. |
| `ISLAND_EXPERIMENT_CONCEPT_MODEL` | Claude Code model used by the local generator to roll three concepts. Defaults to `sonnet`. |
| `UGC_EXPERIMENT_ATTEMPTS` | Local agent/build/autoplay attempts, clamped to 1–3. Defaults to 3. |
| `UGC_EXPERIMENT_TOTAL_TIMEOUT_SEC` | Total durable creative-job deadline. Defaults to 86400 seconds (24h). |
| `UGC_EXPERIMENT_AGENT_TIMEOUT_SEC` | Maximum for one local coding pass, capped by remaining total budget. Defaults to 86400 seconds. |
| `UGC_EXPERIMENT_AGENT_SILENCE_WARN_SEC` | Mark a living agent as silent after no output or `.ts` edits; never kills it. Defaults to 7200 seconds. |
| `UGC_EXPERIMENT_HEARTBEAT_SEC` | PID/output/source heartbeat interval. Defaults to 300 seconds. |
| `UGC_EXPERIMENT_IDLE_SEC` | Manual/conformance idle window. Defaults to 30 seconds. |
| `UGC_EXPERIMENT_MIN_WIN_SEC` | Reject degenerate instant wins below this duration. Defaults to 3 seconds. |
| `UGC_EXPERIMENT_TEST_TIMEOUT_SEC` | Full autoplay timeout per experimental build. Defaults to 150 seconds. |
| `UGC_DEPLOY_WAIT_SEC` | How long experiment publish waits for Render after push. Defaults to 90 seconds. |
| `UGC_DEPLOY_POLL_SEC` | Render poll interval. Defaults to 3 seconds. |
| `UGC_PUBLISH_DRY_RUN=1` | Recheck a local experiment in sandbox and stop before git. |
| `UGC_PUBLISH_COMMIT_DRY_RUN=1` | Build and verify the isolated two-file commit, then remove it without push. |
| `UGC_NO_PUSH=1` | Commit locally, skip `git push`. |
| `PLAYABLES_ROOT` | Local repository containing the pinned source commit used only for disposable free-experiment worktrees. Never used by guided bake. |
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
