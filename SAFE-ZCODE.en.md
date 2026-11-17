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
- Updates come from this repo only: no auto-download and no startup check by default
  ("update check" is one of the seven startup requests disabled out of the box);
  "Check for Updates" queries this repo's Releases once when you click it, and automatic
  updates start only after you enable "Automatically download and install updates" in settings.
- Enter just sends: follow-up defaults to "guide" — Enter sends right away and the agent
  continues after the tool call, no need to learn what a queue is. Switch back to "queue"
  if you prefer batching messages.
- Smaller installer: ~194 MiB official vs ~153 MiB here (Windows x64, same-version
  measurement) — Alibaba telemetry removed entirely, and sourcemaps and other
  non-runtime files stripped.

## Right-click "Open in ZCode" for folders

Install once, launch once — no admin rights, no extra setup:

- Windows: right-click a folder or drive icon, or blank space inside a folder or on
  the desktop, and choose "Open in ZCode" to open that directory as a workspace.
- macOS: select a folder in Finder and pick "Open in ZCode" from the services menu.
- The menu language follows ZCode's interface language (中文 / English).

Note: the Windows menu is written only to the current user's registry (HKCU) and does
not affect other accounts. A leftover menu entry after uninstalling is a known state;
reinstalling and launching once restores it. Linux has no right-click entry yet.

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
- Logs: `logLevel` (warnings and above by default, can be raised back to info) and
  `logRetentionDays` (14 by default).
- Release builds update only from this repo, never from official sources.

## Untouched

Login, chatting, importing shared links — anything you trigger yourself works
online as usual, unaffected by any switch.
