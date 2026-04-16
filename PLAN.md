# Gradient Play — automation companion

Express + React + Tailwind companion app that drives the in-game AI assistant on https://game.gradient-bang.com via a CDP-connected Chrome browser.

## Status: v0.1 — scaffolded and verified end-to-end

- Server: express on :5572, Playwright `connectOverCDP` → :5556 (PortOS browser)
- Client: vite + react + tailwind on :5571
- Snapshot reader pulls ships (name, sector, warp, fighters, shields, credits), bank + on-hand credits, last chat messages
- Mission engine: periodic tick loop → build prompt from goal + guardrails + live state → type into `input[data-slot="input"][placeholder="Enter command"]` + Enter; 2.1s throttle respects in-game limit; abort/stop condition rows (metric/op/value)
- Credentials: macOS Keychain primary (service `gradient-play`), AES-256-GCM file fallback; auto-login flow clicks "Sign In" → fills email/password → "Join"
- Templates: 3 built-ins (trade-until-low-fuel, exploration, tutorial-grind) + user-saved
- SSE mission log stream

## Running

```bash
cd /Users/antic/github.com/atomantic/gradient-play
npm run setup          # one-time: installs deps, seeds .env, builds client
npm start              # serves UI + API on a single port (5572)
# dev with HMR:
npm run dev            # server + vite in parallel (UI :5571, API :5572)
# or:
npm run pm2:start      # for PortOS-style managed run
```

Single-port: http://localhost:5572/   ·   Dev UI: http://localhost:5571/

## Next

- [ ] Persist missions across server restarts (currently in-memory)
- [ ] Ship-specific targeting (currently drives the primary chat; corp fleet coordination is one-prompt-for-all)
- [ ] Assistant-response parser to extract completed trades / task progress and feed back into the next prompt
- [ ] Abort mission if the login page appears mid-run
- [ ] Replace DOM scrape with Zustand-store extraction via React Fiber for authoritative state
