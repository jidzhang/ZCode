/**
 * 更新通道开关：自有更新走 GitHub Releases，默认仍是官方通道（行为零变化）。
 *
 * - `ZCODE_UPDATE_CHANNEL=github|official`（缺省 official；其它拼写构建期直接失败，
 *   与 ZCODE_PREVIEW_IDENTITY 的严格拼写规则同理，避免静默拼错打错包）。
 * - `ZCODE_UPDATE_GITHUB_REPO=owner/repo`（github 通道必填，否则构建期失败，
 *   避免打出“声称自有通道、实际无处可查”的坏包）。
 */
export const ZCODE_UPDATE_CHANNEL_ENV = "ZCODE_UPDATE_CHANNEL";
export const ZCODE_UPDATE_GITHUB_REPO_ENV = "ZCODE_UPDATE_GITHUB_REPO";

export const DESKTOP_UPDATE_CHANNEL_OFFICIAL = "official";
export const DESKTOP_UPDATE_CHANNEL_GITHUB = "github";

export function resolveDesktopUpdateChannel(env = process.env) {
  const raw = env[ZCODE_UPDATE_CHANNEL_ENV]?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === DESKTOP_UPDATE_CHANNEL_OFFICIAL) {
    return DESKTOP_UPDATE_CHANNEL_OFFICIAL;
  }
  if (raw === DESKTOP_UPDATE_CHANNEL_GITHUB) {
    return DESKTOP_UPDATE_CHANNEL_GITHUB;
  }
  throw new Error(
    `invalid ${ZCODE_UPDATE_CHANNEL_ENV}=${env[ZCODE_UPDATE_CHANNEL_ENV]}; expected "github" or "official"`,
  );
}

export function resolveDesktopUpdateGithubRepo(env = process.env) {
  const raw = env[ZCODE_UPDATE_GITHUB_REPO_ENV]?.trim() ?? "";
  const match = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    return null;
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * 打包期 publish 配置：github 通道返回 github provider（electron-builder 自动把
 * 安装包 + latest.yml 传到 Release）；official 通道返回 null，调用方保持现有占位。
 * 公开仓库匿名可用，publish 时按 electron-builder 惯例用 GH_TOKEN。
 */
export function resolveDesktopPublishConfig(env = process.env) {
  if (resolveDesktopUpdateChannel(env) !== DESKTOP_UPDATE_CHANNEL_GITHUB) {
    return null;
  }
  const repo = resolveDesktopUpdateGithubRepo(env);
  if (!repo) {
    throw new Error(
      `ZCODE_UPDATE_CHANNEL=github requires ${ZCODE_UPDATE_GITHUB_REPO_ENV}=owner/repo`,
    );
  }
  return [{ provider: "github", owner: repo.owner, repo: repo.repo, channel: "latest" }];
}
