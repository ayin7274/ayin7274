# dsh-skill-switch

DSH 技能开关插件：在不改动技能文件的前提下，给技能加上「全局默认开关 + 会话级覆盖」。
被禁用的技能对模型和用户都不可见（`modelInvocable` / `userInvocable` 均为 `false`），
需要时可以按会话单独放行。

- 插件名：`dsh-skill-switch`（Cordis 插件 id：`skill-switch`）
- 版本：0.1.0
- 形态：`type: module`，Node.js >= 22，**零运行时 npm 依赖**（宿主 + 客户端两半）
- 宿主侧注册技能 provider、`skill_switch` agent 工具和 `/api/skill-switch` HTTP 路由；客户端侧注册「设置 → 技能开关」页面和输入框底部的「技能」chip。

## 它做什么

1. **全局默认禁用**：把某个技能设为全局 disabled，它就从所有会话的技能清单里消失。
2. **会话级覆盖**：在某个会话里单独启用一个被全局禁用的技能，或单独禁用一个默认开启的技能；其它会话不受影响。
3. **禁用即隐藏**：被禁用的技能以 rank 0 的「影子候选」返回，调用/内容均不可用；重新启用时恢复 rank 1 的真实候选。
4. **来源目录**：可以把额外的技能目录加入扫描来源（只读扫描一层：`<dir>/SKILL.md` 或扁平 `<name>.md`）。
5. **托管技能**：在 `$DSH_HOME/skill-switch/skills/<name>/SKILL.md` 下直接创建/删除小型技能。
6. **Agent 工具**：`skill_switch`，让 agent 在会话里自行列技能、开关技能、管理来源与托管技能。

## 用户入口

| 入口 | 位置 | 能做什么 |
| --- | --- | --- |
| 技能 chip | 会话输入框底部（composer dock，order 40） | 列出当前会话的技能，逐个开关；恢复会话默认 |
| 设置 → 技能开关 | 设置页 section（order 60） | 全局禁用、查看各会话覆盖数、重置全部会话、管理来源目录与托管技能 |
| `skill_switch` 工具 | agent 工具 | `list` / `set` / `reset_session` / `reset_sessions` / `add_source` / `remove_source` / `add_skill` / `remove_skill` / `refresh` |

面板里的每一项都会显示来源（user / project / source / managed / bundled / disabled）和当前状态徽标。
被禁用但仍在状态文件里留有记录的技能会以 `missing` 标记显示，便于清理。

## 安装

在目标 DSH profile 中把本目录以 link 方式加入（以本机 desktop profile 为例）：

```powershell
dsh plugin --profile desktop add link:C:\Users\Administrator\Documents\deepseek-harness\default-workspace\plugins\dsh-skill-switch
```

装好后**重启 DSH**，并**刷新页面**（客户端模块只在启动时注入）。如果使用其它 profile，把 `--profile desktop` 换成对应名字。

## 状态文件与优先级

状态保存在：

```
$DSH_HOME/skill-switch/state.json
```

Windows 下通常是 `C:\Users\<用户名>\.dsh\skill-switch\state.json`。写入是原子的（临时文件 + rename）；文件损坏时会自动改名为 `state.json.bak` 并以空状态继续，不会让宿主启动失败。

生效优先级（从高到低）：

```
会话单独启用  >  会话禁用  >  全局禁用  >  默认
```

对应 payload 里的 `reason`：`session-enabled` / `session-disabled` / `global` / `default`。
会话覆盖按 `sessionId` 隔离；`sessionsWithOverrides` 统计还有覆盖的会话数量。

技能发现顺序（同名先到先得）：

1. 托管技能目录 `$DSH_HOME/skill-switch/skills/`
2. 设置页添加的额外来源目录
3. 项目级 `<cwd>/.dsh/skills/`、`<cwd>/.agents/skills/`
4. 用户级 `$DSH_HOME/skills/`
5. 宿主注册的其它 provider（agent preset / bundled 等，由宿主合并）

## HTTP API

客户端通过同源请求访问，前缀 `/api/skill-switch`（不设 CORS）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state?sessionId=&cwd=` | 完整状态 payload（`ok, sessionId, cwd, globalDisabled, session, sessionsWithOverrides, sources, managed, skills`） |
| POST | `/toggle` | `{name, scope: 'session'\|'global', disabled, sessionId?, cwd?}` |
| POST | `/reset-session` | `{sessionId}` |
| POST | `/reset-sessions` | 清空所有会话覆盖 |
| POST | `/source` | `{action: 'add'\|'remove', path}` |
| POST | `/managed` | `{action: 'add'\|'remove', name, description?, content?}` |

响应为 `application/json; charset=utf-8`。参数校验失败返回 400 `{ok:false,error}`，未知路径/方法返回 404 `{ok:false,error:'not found'}`，内部错误 500。

## 已知限制

- **agent-preset 作用域技能无法禁用**：宿主技能合并时 agent preset 层覆盖全局层。预设自带的技能即使全局禁用，在该预设的会话里仍可能以真实候选出现；本插件的「会话禁用」对这类技能同样不生效。
- **idle 会话可能看不到 agent-preset / bundled 技能**：没有活跃 agent 时读不到 agent scope 的快照，技能面板与 `/` 菜单可能只显示文件系统来源的技能；回到活跃会话或刷新后恢复。
- **`/` 菜单可能滞后于会话覆盖**：菜单来自宿主的技能快照缓存，个别情况下需要重新打开会话或刷新页面才能反映最新的会话级开关。
- **项目级技能依赖 cwd**：插件优先用请求/工具传入的 cwd，否则回退 `workingDirectory.defaultDirectory`；没有 cwd 的项目根不会被扫描。
- **只影响技能可见性**：开关改变的是技能候选（模型调用/用户调用），不改变 agent 的工具绑定、权限或其它工具的行为；与技能同名的业务工具是否可用由宿主与 agent 绑定决定。
- **会话覆盖会保留**：即使会话结束后仍记录在 `state.json` 中，可在设置页「重置全部会话」或工具 `reset_sessions` 清理。

## 故障排查：客户端插件导致启动崩溃

`client.js` 的 `inject` 必须列出 `apply(ctx)` 里读取的**每一个**服务（当前是 `['slots', 'locale']`）。Cordis 客户端对未声明 inject 的服务属性访问会直接抛错：

```
Error: cannot get property "locale" without inject
```

该错误会让这个 client entry 激活失败，桌面端把 `web boot: N entry did not activate` 视为致命 → 启动页崩溃，并**自动重置 profile**（bundles 被裁剪成 base + web-app，`cordis.patch.yml` 换回默认层，原文件留成 `cordis.patch.yml.bak-<ts>`）。

排查与恢复：

1. 看 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`，搜 `entry did not activate` 和插件名。
2. 用临时 `DSH_HOME` + 只含 base/web-app/本插件的隔离 profile 复现；用 headless 浏览器打开页面看 renderer console，或临时给 `apply` 包 try/catch 打印真实异常。
3. 恢复 profile：拷回 `package.json.bak-*` / `cordis.patch.yml.bak-*`，再补回本插件依赖（`link:` 绝对路径）和 `dsh.profile.bundles` 条目，并在 `node_modules` 建 junction。
4. 修完先跑 `node scripts/selfcheck.mjs`，再用全量隔离 profile 冒烟启动，最后才重启桌面端。

## 验证

```powershell
cd plugins/dsh-skill-switch
node scripts/selfcheck-host.mjs     # 期望输出 PASS host
node scripts/selfcheck-client.mjs   # 期望输出 PASS client
node scripts/selfcheck.mjs          # 期望末尾输出 ALL PASS
```

`scripts/selfcheck.mjs` 会依次运行上面两个脚本，再做 package.json / cordis.patch.yml / locale / 模块边界 / 必需标记等静态契约检查；全部通过退出码为 0。

安装后可只读验证 HTTP 路由（需要 DSH 正在运行）：

```powershell
Invoke-RestMethod http://127.0.0.1:62982/api/skill-switch/state
```

## 目录结构

```
index.js                宿主入口：provider / agent 工具 / HTTP 路由注册
client.js               客户端入口：设置页 section + composer dock chip
lib/frontmatter.js      SKILL.md frontmatter 解析与序列化
lib/scan.js             技能目录扫描（managed / source / project / user）
lib/state.js            state.json 读写、原子写、损坏备份、生效规则
lib/skill-switch.js     核心服务：provider、payload、开关与来源/托管操作
lib/http.js             /api/skill-switch 路由处理
locale/zh.json          中文文案
locale/en.json          英文文案
cordis.patch.yml        Cordis 插件清单
scripts/                自检脚本
```
