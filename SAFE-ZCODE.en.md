# safe-zcode Notes

This repo = upstream ZCode snapshot + personal hardening (baseline v3.14.3).
One goal: quiet by default, online only when it should be.

## Out of the box

- No reporting: telemetry and trace reporting are off by default; packages ship no reporting endpoints.
- No background chatter: the app does not contact official servers at startup. Seven kinds of
  background requests (update check, upgrade prompt, rollout flags, help links, model list,
  plugin marketplace, remote icons) are all disabled, each falling back to local data.
- No leaking: conversation sharing is off by default; your chats are never uploaded to official servers.
- Daily builds never self-update; Check for Updates simply reports you are on the latest version.

## Opt in (settings file, restart to apply)

- Startup egress: add `"enableStartupOutbound": true` to `~/.zcode/v2/setting.json`
  to restore rollouts, help links, model list, and friends.
- Logs: `logLevel` (info by default, can be narrowed to errors only) and
  `logRetentionDays` (14 by default).
- Release builds update only from this repo, never from official sources.

## Untouched

Login, chatting, importing shared links — anything you trigger yourself works
online as usual, unaffected by any switch.

## Feishu channel

Expired tokens heal themselves; the circuit breaker half-opens automatically after
a minute. No restart needed.
