# Owner's manual

What you do, in order. Everything else runs by itself.

## 1. One-time setup on your computer
1. Install **Node.js 22 or newer** (https://nodejs.org) and **git**, and sign in to GitHub so `git push` works.
2. Clone the repo and open a terminal in it.
3. Optional pieces, each in the git-ignored `private/` folder (never committed, never sent anywhere else):

| File | What it turns on |
|---|---|
| `private/kalshi-key-id.txt` + `private/kalshi-key.pem` | The live stream (order books, trades, settlements). Read-only by construction. Check: `node kalshi-auth.mjs` |
| `private/alerts.json` | Phone alerts. `{ "ntfy": "https://ntfy.sh/<a-long-random-topic>" }` (install the ntfy app and subscribe to the same topic) or `{ "discord": "<webhook url>" }`. Check: `node live/alerts.mjs "Test" "hello"` |
| `private/anthropic-key.txt` | Claude for hard cases only, under the daily cap (`config.json → llm.dailyCapUsd`, default $1). Also run `npm install` once. |

4. Local language model (free): install **Ollama** (https://ollama.com), then:
```bash
ollama pull llama3.2:3b
```
```bash
ollama pull nomic-embed-text
```
   With 16 GB of RAM or more a 7–8B model reads better: pull it and set `config.json → llm.local` (for example `qwen2.5:7b`).
   Check: `node llm.mjs`. Without Ollama everything else still runs; the news, `llm` predictor and LLM evals are skipped.
5. Turn on the public page once: GitHub → the repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**
   (the `Publish dashboard` workflow then deploys the `site` branch after every update). The page is https://thexpaintedxtiger.github.io/kalshi-feed/.

## 2. Start it
```bash
./start.sh
```
Windows: double-click `start.cmd`. It pulls new code, starts the daemon and restarts it if it ever exits.
Open **http://localhost:8787** for the live dashboard. To stop: Ctrl+C twice (or close the window).

Options (environment variables): `NO_PUSH=1` local only · `NO_KEY=1` ignore the key · `PORT=8787` · `RECORD_RAW=1` keep every
stream message in `local/raw/` (for replay tests).

## 3. Keep it running 24/7
- **Don't let the computer sleep.** Windows: Settings → System → Power → Sleep: Never (when plugged in). Mac: `start.sh` uses
  `caffeinate` for you. Linux: `start.sh` uses `systemd-inhibit` where available.
- **Start at login / survive reboots:**
  - *Windows (Task Scheduler):* Create Task → Trigger "At log on" → Action "Start a program": `cmd.exe`, arguments
    `/c "C:\path\to\kalshi-feed\start.cmd"` → Settings: "If the task fails, restart every 1 minute".
  - *Mac (launchd):* save as `~/Library/LaunchAgents/com.kalshi-feed.plist`, then `launchctl load` it:
    ```xml
    <plist version="1.0"><dict><key>Label</key><string>com.kalshi-feed</string>
    <key>ProgramArguments</key><array><string>/bin/bash</string><string>/path/to/kalshi-feed/start.sh</string></array>
    <key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
    ```
  - *Linux (systemd user service):* `~/.config/systemd/user/kalshi-feed.service`, then `systemctl --user enable --now kalshi-feed`:
    ```ini
    [Service]
    ExecStart=/bin/bash /path/to/kalshi-feed/start.sh
    Restart=always
    [Install]
    WantedBy=default.target
    ```
- If the computer is off, the free cloud job takes over every 10 minutes (no live stream) and steps aside when you come back.

## 4. Reading the dashboard
- **Header pill:** green = stream live; amber = running on REST prices (no key, or the stream is reconnecting); red = no heartbeat.
- **Should I trade?** The answer, and the specific evidence that is missing. It changes by itself when a model passes.
- **Live:** prices, each model's estimate, edge after fees, countdown. Tap a row for the order book and history.
- **Models:** one card per model. The bar is the *peeking-safe range*: it stays valid however often you look. Left of zero is better
  than the market. A model passes only when the whole bar is left of zero **and** its picks make money after fees.
- **Breakdowns:** by category and lead time, calibration, biggest misses, leakage checks (must all be zero).
- **Paper:** paper portfolios vs "hold cash" and "coin flip"; the maker (resting order) portfolio.
- **Ops:** reconnects, memory, cycle time, LLM spend, storage, the decisions the agent made.
- On a phone: open the page → Share → **Add to Home Screen**.

## 5. What needs you
- **Real money. Nothing else.** The system has no order code. If a model ever reaches SUCCESS you get an alert and the evidence;
  placing or enabling any real order is your decision alone.
- Raising the Claude daily cap (`llm.dailyCapUsd`).
- Things only you can fix: the computer being off, an expired key, GitHub login, disk space. The watchdog names them.

## 6. If something looks wrong
| You see | Do |
|---|---|
| Header red "daemon stopped" | Start `start.sh` / `start.cmd`. Look at the end of `local/daemon.log`. |
| Amber for a long time with a key installed | `node kalshi-auth.mjs` (is the key still valid?). |
| Page shows old data but the daemon runs | `git push` login problem: run `git push` by hand once in the folder. |
| "Leakage violations" not 0 | Tell Claude: it is a bug in a data source's timestamps, not a result. |
| Want to check everything | `node test.mjs` (about 5 seconds) |

## 7. Your own trades (optional, private)
`node import-trades.mjs private/kalshi-trades.csv` or `node import-trades.mjs --api` writes a private report to `private/`.
Nothing from `private/` is ever committed or published.
