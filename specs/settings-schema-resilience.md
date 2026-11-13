# 设置文件解析容错（单个非法键不得重置整份设置）

## 背景

用户实测两次：安装新版本后 `setting.json` 里的 `httpProxy` 丢失。日志铁证：

```
[startup-workspace] invalid settings file, falling back to default workspace:
  zcodeInteractionBehavior: Invalid option: expected one of "queue"|"guide"
```

根因：设置读取走 `appSettingsSchema.safeParse` **整体校验**——任一键非法 → 整份失败 →
回退 `defaultSettings()` → 后续迁移/投影写盘用默认值覆盖文件，代理等全部偏好静默消失。

JSON 是开放格式，允许用户手动编辑；旧版本留下的未知枚举值（例如 fork 撤回的实验档位）
或手误不应该抹掉整份配置。文件自身的 `dynamicWorkflowModeSettingSchema` 早已有此纪律注释
（“不能让一个偏好字段把整份设置读坏”），本 spec 把它提升为全局规则。

## 产品规则

1. `parseAppSettingsLenient(value)` 是设置读取的唯一入口：
   - 整体合法 → 正常返回；
   - 整体非法 → **按顶层键逐个解析**，非法的键丢弃并回落该键默认值，其余键原样保留；
   - 未知键维持旧行为（忽略）。
2. 读到非法键时不立即写盘（`schemaInvalid` 标记）：保留文件原样，仅内存使用清洗后的值，
   等用户下次显式保存再收敛。避免启动期把用户手改内容覆盖掉。
3. 非法键以 `warn` 级别记录键名（不记录值，防泄漏代理/内网地址）。
4. 桌面端启动工作区读取（`startupWorkspace.ts`）同样走宽松解析，不再整份回退。

## 接口与所有者

- `packages/shared/src/validationAppSettings.ts`：`parseAppSettingsLenient` 为唯一宽松入口；
  `appSettingsSchema` 保持严格（写盘与命令校验仍要求完整合法）。
- `packages/services/src/setting/settingService.ts`：唯一读盘所有者，负责 `schemaInvalid`
  时跳过自动迁移写盘。
- 桌面 `startupWorkspace.ts` 只读，不作写方。

## 验收场景

1. `setting.json` 含一个非法枚举值 + 合法 `httpProxy`/工作区历史 → 启动后代理仍生效，
   日志一条 warn 列出非法键名。
2. 上述状态下不产生覆盖写：文件内容保持原样（非法键仍在）。
3. 用户在设置页保存任一偏好 → 写盘收敛为合法内容（仅丢弃非法键，其余全保留）。
4. 完全合法的设置文件：读取结果与改动前逐字节一致（回归）。
5. 非 JSON 文件：维持既有“隔离坏文件 + 默认值”路径（不属本 spec 的静默回退范围）。