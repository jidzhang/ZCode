/**
 * safe-zcode 本地 UI 覆盖：账号登录推送白名单（2026-09-27）。
 *
 * 修复原因：上游把账号登录做成强推送——①启动守卫在"未登录且无可用 provider"
 * 或从未绑定账号域时全屏拦截（Root 的 startup-provider-required）；②上游未实现
 * refresh token（oauthService.refreshToken 直接抛"请重新登录"），OAuth token
 * 隔夜过期后 session-expired 全屏重登页反复出现。fork 立场（见 LOCAL-CHANGES.md
 * 登录调研条目）：登录链路保留但不推送——账号型模型过期时由请求层 401 报错提示，
 * 用户自行换 API key 或从侧栏手动重登，与 codex/claude CLI 的体验一致。
 *
 * 机制依据：WelcomeScreen 的全部主动打开路径收敛在 Root.tsx 的
 * setWelcomeScreenOpenReason(reason)（5 值枚举：startup-provider-required /
 * session-expired / logout-provider-required / provider-request / manual-login），
 * 本文件维护"允许开屏"的白名单，白名单外（含上游未来新增的推送 reason）默认吞掉。
 * 被动登录入口（侧栏账号区、/login、设置 API key 表单）不经过该 setter，不受影响。
 */

/** 允许打开全屏登录页的 reason：仅保留用户主动触发的三类。 */
const WELCOME_SCREEN_ALLOWED_OPEN_REASONS: readonly string[] = [
  // 手动登录入口（侧栏账号区、命令面板 /login 等）。
  "manual-login",
  // 用户选择了需要账号的模型（如订阅套餐模型）后触发的连接引导。
  "provider-request",
  // 用户主动登出后，因无可配 provider 而引导重新连接。
  "logout-provider-required",
];

export function isWelcomeScreenOpenReasonAllowed(reason: string): boolean {
  return WELCOME_SCREEN_ALLOWED_OPEN_REASONS.includes(reason);
}

/** 白名单外的开屏请求折叠为 null（不开屏）；关闭请求（null）原样放行。 */
export function filterWelcomeScreenOpenReason<T extends string>(reason: T | null): T | null {
  if (reason === null) return null;
  return isWelcomeScreenOpenReasonAllowed(reason) ? reason : null;
}
