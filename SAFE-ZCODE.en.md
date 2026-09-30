# Safe ZCode Notes

This repo = upstream ZCode snapshot + personal hardening, tracking upstream.
One goal: quiet by default, online only when it should be.

## Out of the box

- No reporting: telemetry and trace reporting are off by default; packages ship no reporting endpoints.
- No background chatter: the app does not contact official servers at startup. Seven kinds of
  background requests (update check, upgrade prompt, rollout flags, help links, model list,
  plugin marketplace, remote icons) are all disabled, each falling back to local data.
- No leaking: conversation sharing is off by default; your chats are never uploaded to official servers.
- No secret spill: credentials caught in tool summaries, error messages, or permission
  prompts sent to Feishu/WeChat are masked before delivery; paths and links stay readable.
- Daily builds never self-update; Check for Updates simply reports you are on the latest version.
- Smaller installer: ~143MB vs ~170MB official for the same version — Alibaba telemetry
  removed entirely, and sourcemaps and other non-runtime files stripped.

## Feishu / WeChat channels

The channel is a **direct connection** between the client and Feishu / WeChat:
messages travel only between your client and each provider's own official
servers — no intermediary domains, nothing in between.

- **Resilient**: Feishu tokens invalidated early by the server are refreshed
  and retried automatically, and the circuit breaker half-opens after a minute.
  Replies are never silently dropped.
- **No lost input**: messages sent while a task is running are queued instead
  of rejected; `/stop` interrupts when you'd rather not wait.
- **Easy switching**: `/task` jumps to a recent conversation, `/project`
  switches workspaces, and `/reconnect` revives a dropped remote workspace.
- **Discoverable**: help lists every command with its Chinese aliases.

## Opt in (settings file, restart to apply)

- Startup egress: add `"enableStartupOutbound": true` to `~/.zcode/v2/setting.json`
  to restore rollouts, help links, model list, and friends.
- Logs: `logLevel` (info by default, can be narrowed to errors only) and
  `logRetentionDays` (14 by default).
- Release builds update only from this repo, never from official sources.

## Untouched

Login, chatting, importing shared links — anything you trigger yourself works
online as usual, unaffected by any switch.
