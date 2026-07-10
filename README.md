# swipe-ugc

Hosting repo for **player-generated mechanics** (the island meta, triangle tab in
the feed). Deliberately separate from `swipe-platform`: that repo is the
git-deployed first-party artifact; this one receives runtime UGC commits from
the bake worker and is served as a static site (Render). A separate origin also
sandboxes UGC code away from the platform's localStorage/session.

Everything under `u/` is a generated artifact — do not hand-edit.

## Layout

```
u/<user>/<slug>-<hash8>.html          baked fork (shell)
u/<user>/<slug>-<hash8>.payload.js    baked fork (payload with the theme applied)
worker/bake.mjs                       recipe → bake → test → publish → notify
```

The content hash in the filename makes every artifact immutable: a new version
is a new file, caches never need busting (same trick as `versions.json` on the
platform, for free).

## Worker

```bash
node worker/bake.mjs --pack '<theme-pack json>' --prompt 'затерянная атлантида' --user dev
```

Pipeline: read the base build (`playables/marble-sort-swipe/dist-swipe`), apply
the recipe (marble-palette substitution in the payload), write the fork under
`u/<user>/`, **autoplay-test it in headless chromium** (playwright, resolved
from the workspace root `node_modules` — the worker currently assumes it runs
inside the workspace), then `git commit` + `push`, then notify the player via
the Telegram bot.

In dev the worker is invoked automatically by the feed dev server after every
successful theme generation (`feed-prototype/vite.config.ts` → `islandThemeApi`)
— a fire-and-forget background job, the player's flow never waits for it.

### Env

| Var | Meaning |
|---|---|
| `UGC_FULL_WIN=1` | Test gate = full autoplay WIN (`completed` postMessage, slow). Default gate: boot (canvas/ready) + error-free grace period. |
| `UGC_NO_PUSH=1` | Commit locally, skip `git push`. |
| `BOT_TOKEN` | Telegram bot token (same var name as swipe-bot). Notification is skipped (and logged) when absent. |
| `UGC_NOTIFY_CHAT_ID` | Chat to notify. Get yours: send `/start` to the bot, then `curl https://api.telegram.org/bot$BOT_TOKEN/getUpdates` → `message.chat.id`. |
| `UGC_BASE_URL` | Public base URL of this repo's static site (e.g. `https://swipe-ugc.onrender.com`). Used in the notification link. |

## Hosting (Render)

`render.yaml` describes a free static site. Connect this repo in the Render
dashboard once; every worker push auto-deploys (~1 min). When volume outgrows
git-as-storage, the worker's publish step swaps to S3/R2 — nothing else changes.

## Production notes

This worker runs on the dev machine as a rehearsal of the real pipeline. The
production version is the same steps on a backend worker: theme via API (not
subscription CLI), bake, the same playwright gate, upload, bot push with a
`t.me/<bot>/<app>?startapp=island` deep link.
