# dsh-skill-switch 实现契约（SPEC）

> 本文档是 Lead 与子代理之间唯一接口契约。**实现必须与本文档逐字一致**（字段名、路径、行为、错误语义）。
> 修改契约需先告知 Lead；不得擅自改 package.json / 本文件 / profile 配置。

## 0. 目标与硬约束

**目标**：DSH 插件，让用户在每个会话内自由加载/卸载 skill，同时保留全局默认配置；全局可一键把所有会话恢复默认；会话改动优先于全局。

**硬约束**
- 包名 `dsh-skill-switch`，cordis id `skill-switch`，版本 0.1.0。
- **零运行时 npm 依赖**：host 只用 `node:fs` / `node:path` / `node:os` / `node:url` 等内置模块；client 只 `require('react')`（module table 提供）。
- 纯 ESM（`type: module`），Node >= 22，Windows 路径必须正常（`path.join`，不要手拼 `/`）。
- 运行期**只写** `$DSH_HOME/skill-switch/` 下的文件；不得写插件包目录、不得改 profile。
- 所有状态写入用「临时文件 + rename」原子替换。
- 不引入 defineTool / 不 import `@deepseek-ai/*`（可选 peer 可能导致激活失败）。
- 中文注释可；用户可见文案走 locale。

## 1. 文件与所有权

| 文件 | 所有者 | 说明 |
|---|---|---|
| `package.json` | Lead（已写） | 不改；`main=index.js`、`exports` 含 `./client`、`./locale/*.json`、`./icon`；`dsh.bundle.patch`、`dsh.client` 已配 |
| `cordis.patch.yml` | Lead（已写） | `- insert: - id: skill-switch  name: dsh-skill-switch  config: {}` |
| `icon.svg` | Lead（已写） | 48x48 |
| `index.js` | **host-dev** | host 入口：provider + 工具 + HTTP |
| `lib/frontmatter.js` | **host-dev** | 容错 frontmatter 解析/序列化 |
| `lib/scan.js` | **host-dev** | 扫描技能根 |
| `lib/state.js` | **host-dev** | state.json 读写 + effective 规则 |
| `lib/skill-switch.js` | **host-dev** | 核心服务（provider、list、toggle、reset、source、managed） |
| `lib/http.js` | **host-dev** | `/api/skill-switch` 路由 |
| `scripts/selfcheck-host.mjs` | **host-dev** | host 半边自检（假 ctx + 临时 DSH_HOME） |
| `client.js` | **ui-dev** | 设置页 section + composer.dock 面板 |
| `locale/zh.json`、`locale/en.json` | **ui-dev** | 扁平 key 字典 |
| `scripts/selfcheck-client.mjs` | **ui-dev** | client 半边自检（假 window/ctx/document） |
| `scripts/selfcheck.mjs` | **verifier** | 汇总 runner + 契约检查 |
| `README.md` | **verifier/Lead** | 用户说明 + 已知限制 |

## 2. host 入口 `index.js`

```js
export const name = 'skill-switch'
export const inject = ['skills', 'tools', 'webServer', 'workingDirectory', 'agents']

export function apply(ctx, config) {
  // 1) 创建核心服务（见 §6），并把 invalidate 挂钩到 provider 注册的 control
  // 2) ctx.tools.register(skillSwitchTool(ctx, service))
  // 3) ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/skill-switch', handler }), 'skill-switch-http')
}
```

- `ctx.skills.registerProvider((control) => provider)`；保存 `control.invalidate`，服务内每次写状态后调用（异常吞掉并 warn）。
- `apply` 不允许抛错（DSH 激活失败会整条 warn 掉）。
- `config` 允许为空对象；忽略未知字段。

## 3. `lib/frontmatter.js`

```js
/** 解析 `--- ... ---` frontmatter。返回 { data, body }。 */
export function parseFrontmatter(text) // text 允许 BOM/CRLF；无 frontmatter 返回 { data: {}, body: text }
/** 序列化托管技能。 */
export function serializeSkill({ name, description, whenToUse, content }) // → '---\nname: ...\n---\n<body>\n'
```

- 只支持用到的 YAML 子集：`key: scalar`、`key: "quoted"` / `'quoted'`、`key: |` / `key: >` 块、`true/false` 布尔。忽略注释行 `# ...`。
- `parseFrontmatter` 对无法解析的行**尽量容错**（保留为字符串），不抛错；`discover` 侧再做校验。
- 值两侧空白 trim；`|`/`>` 块保留换行（`>` 折叠换行）。
- `serializeSkill` 描述中的换行必须拒绝（由调用方校验），或替换为空格。

## 4. `lib/scan.js`

```js
/**
 * @param {{ dshHome: string, cwd?: string, sources?: string[], managedDir: string }} opts
 * @returns {SkillEntry[]}
 */
export function discoverSkills(opts)

// SkillEntry:
// { name, description, whenToUse?, invocation: {modelInvocable:boolean, userInvocable:boolean},
//   path, directory, source: 'managed'|'source'|'project'|'user', root }
```

- 扫描根（按优先级顺序；同名去重保留先出现者）：
  1. `managedDir` → source `'managed'`
  2. `opts.sources[]` 每个目录 → source `'source'`
  3. `<cwd>/.dsh/skills` → `'project'`（仅当 cwd 存在）
  4. `<cwd>/.agents/skills` → `'project'`（仅当 cwd 存在）
  5. `join(dshHome, 'skills')` → `'user'`（跳过 `.system` 子目录）
- 每个根只扫一层：
  - `<root>/<dir>/SKILL.md`：name 优先取 frontmatter.name，否则用目录名（必须 kebab-case）；description 取 frontmatter，缺失时取正文第一行非空，再缺失用 name。
  - `<root>/<file>.md`：仅当文件名是 kebab-case 才收录；name 取 frontmatter.name 或文件名。
- 跳过 `node_modules`、`.git`、隐藏目录（`.` 开头）与 `.system`（user 根）。
- 文件系统错误（目录不存在/无权限/读失败）→ 跳过该根/该技能，不抛错。
- invocation：`modelInvocable = data['disable-model-invocation'] !== true`；`userInvocable = data['user-invocable'] !== false`；出现旧键 `disableModelInvocation`/`modelInvocable`/`userInvocable` 视为解析失败并跳过该技能（warn）。
- 只读操作，不写文件。

## 5. `lib/state.js`

```js
export const STATE_VERSION = 1
export function emptyState() // { version:1, global:{disabled:{}}, sessions:{}, sources:[] }
export function loadState(file) // 不存在→emptyState；损坏→把坏文件改名 .bak 后返回空状态（warn）
export function saveState(file, state) // mkdir -p；tmp+rename；JSON 2 空格
export function effective(state, sessionId, name) // → { enabled:boolean, reason:'default'|'global'|'session-enabled'|'session-disabled' }
```

state.json schema（严格）：

```json
{
  "version": 1,
  "global": {
    "disabled": {
      "office": { "description": "…", "source": "bundled", "path": null, "disabledAt": "2026-11-13T05:00:00.000Z" }
    }
  },
  "sessions": {
    "<sessionId>": {
      "enabled": { "office": { "updatedAt": "…" } },
      "disabled": { "tdd": { "description": "…", "source": "user", "path": "C:\\…\\SKILL.md", "updatedAt": "…" } },
      "updatedAt": "…"
    }
  },
  "sources": [ { "path": "C:\\…", "addedAt": "…" } ]
}
```

`effective` 规则（会话优先）：
1. `sessions[sid].enabled[name]` 存在 → `{enabled:true, reason:'session-enabled'}`
2. `sessions[sid].disabled[name]` 存在 → `{enabled:false, reason:'session-disabled'}`
3. `global.disabled[name]` 存在 → `{enabled:false, reason:'global'}`
4. 否则 → `{enabled:true, reason:'default'}`

## 6. `lib/skill-switch.js`

```js
/** @param {{ ctx:any, dshHome:string, logger?:any }} opts */
export function createSkillSwitch(opts) // → service
```

service 成员：

- `paths`：`{ root, stateFile, managedDir, skillsDir }`，其中 `root = join(dshHome,'skill-switch')`、`stateFile = join(root,'state.json')`、`managedDir = join(root,'skills')`。
- `provider()`：返回 `{ name:'skill-switch', list(options), get(candidate, options) }`，语义见 §6.1。
- `list({ sessionId, cwd })`：→ §7 payload。
- `toggle({ name, scope, sessionId, cwd, disabled })`：→ payload；scope=`'global'` 时不要求 sessionId；scope=`'session'` 时必须 sessionId。
- `resetSession({ sessionId })` / `resetSessions()`：→ payload。
- `addSource(path)` / `removeSource(path)`：→ payload。
- `addManaged({ name, description, content })` / `removeManaged(name)`：→ payload。
- 任何写操作成功后：`saveState` + 调用 `invalidate()`（吞异常）。
- `list` 的 cwd 解析：`cwd || ctx.get('workingDirectory')?.defaultDirectory`（若该值不是字符串则 undefined）；不依赖 client 的 session 列表。
- resolve 会话对应 live agent：`ctx.get('agents')?.get?.(sessionId)`；只用于给 `ctx.skills.snapshot` 传 `scope`，拿不到就省略。

### 6.1 provider 契约

- `list(options)`：`options = { cwd, scope?, signal? }`；`sid = options?.scope?.session?.id ?? null`。
- 步骤：
  1. `state = loadState()`
  2. `entries = discoverSkills({ dshHome, cwd, sources, managedDir })`
  3. `records` = global.disabled ∪ sessions[sid].disabled ∪ sessions[sid].enabled 的 name 集合（带元数据）
  4. 对 `entries ∪ records` 的每个 name：
     - `eff = effective(state, sid, name)`
     - `eff.enabled === false` → 输出 **shadow 候选**：
       `{ name, description: entry?.description ?? record?.description ?? name, invocation:{modelInvocable:false,userInvocable:false}, provider:'skill-switch', source:'disabled', rank:0, locator:{ kind:'disabled', name } }`
     - 否则若 `entry` 存在且（`entry.source === 'managed' || entry.source === 'source' || sessions[sid]?.enabled?.[name]`）→ 输出 **真实候选**：
       `{ name, description, whenToUse?, invocation, provider:'skill-switch', source: entry.source, rank:1, locator:{ kind:'file', path: entry.path }, resourceBase:{ kind:'directory', path: entry.directory } }`
     - 其余（默认启用、由 filesystem provider 提供的普通技能）→ **不输出**。
  5. 返回候选数组（可空）。
- `get(candidate, options)`：
  - `locator.kind === 'file'` → 读取/解析该文件，返回
    `{ name, description, whenToUse?, invocation, source, provider:'skill-switch', resourceBase:{kind:'directory',path:dir}, path, content: body.trim() }`
  - `locator.kind === 'disabled'` → 返回
    `{ name, description, invocation:{modelInvocable:false,userInvocable:false}, source:'disabled', provider:'skill-switch', content:'This skill is disabled for the current session. Enable it in Settings → Skill Switch or via the session skill panel.' }`
  - 名称必须与 candidate.name 一致；读取失败抛错（registry 会跳过并标记 incomplete）。
- `rank` 必须用数字 0/1；`provider` 字段必须等于 `'skill-switch'`；`description` 非空字符串。

## 7. HTTP 契约（`lib/http.js`）

`createHandler(service)` → `async (req, res) => void`，挂在 `{ kind:'prefix', path:'/api/skill-switch' }`。

- 路径取 `new URL(req.url, 'http://127.0.0.1')` 的 pathname，前缀剥离后为 `/state`、`/toggle` 等。
- GET `/state?sessionId=&cwd=`；其余为 POST，body 为 JSON（上限 256KB，空 body 视为 `{}`）。
- 成功：`200` + payload（§7.1）。校验错误：`400 {ok:false,error}`；内部错误：`500 {ok:false,error}`。
- 响应头 `content-type: application/json; charset=utf-8`；不设 CORS（同源）。
- 未知路径/方法 → 404 `{ok:false,error:'not found'}`。
- body JSON 解析失败 → 400。

### 7.1 payload（所有接口都返回它）

```json
{
  "ok": true,
  "sessionId": "sess_123" ,
  "cwd": "C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace",
  "globalDisabled": ["office"],
  "session": { "enabled": ["office"], "disabled": ["tdd"] },
  "sessionsWithOverrides": 2,
  "sources": [ { "path": "D:\\my-skills", "addedAt": "…" } ],
  "managed": [ { "name": "my-skill", "description": "…", "path": "C:\\…\\SKILL.md" } ],
  "skills": [
    {
      "name": "office",
      "description": "…",
      "source": "user",
      "path": "C:\\…\\SKILL.md",
      "enabled": false,
      "reason": "session-disabled",
      "managed": false,
      "missing": false
    }
  ]
}
```

- `sessionId` 可为 `null`；`session` 无该会话时为 `null`。
- `skills` 合并来源：`ctx.skills.snapshot({cwd, scope?})` 的 skills（失败则跳过）+ `discoverSkills` + state 记录；按 name 去重；排序 `name` 升序。
- `skills[].reason` 取值固定：`'default'|'global'|'session-enabled'|'session-disabled'`。
- `missing: true` 表示只有 state 记录、磁盘/registry 都找不到（如技能目录已删）。
- `source` 用 `'user'|'project'|'source'|'managed'|'bundled'|'disabled'|'unknown'`。

### 7.2 各接口参数

| method | path | body |
|---|---|---|
| GET | `/state` | query `sessionId?`、`cwd?` |
| POST | `/toggle` | `{name, scope:'session'\|'global', sessionId?, cwd?, disabled:boolean}` |
| POST | `/reset-session` | `{sessionId, cwd?}` |
| POST | `/reset-sessions` | `{cwd?}` |
| POST | `/source` | `{action:'add'\|'remove', path, cwd?}` |
| POST | `/managed` | `{action:'add'\|'remove', name, description?, content?, cwd?}` |

### 7.3 写语义（严格）

- `toggle` global：`disabled=true` → 写入 `global.disabled[name]`（元数据见 §7.4）；`disabled=false` → 删除该记录（其他会话的显式覆盖不动）。
- `toggle` session：
  - `disabled=true` → `sessions[sid].disabled[name]=元数据`，并删除 `sessions[sid].enabled[name]`；
  - `disabled=false` → 删除 `sessions[sid].disabled[name]`；若 `global.disabled[name]` 存在 → 写 `sessions[sid].enabled[name]={updatedAt}`，否则删除 `enabled[name]`（等于回到默认）；
  - 更新 `sessions[sid].updatedAt`；若该会话 enabled/disabled 均为空则删除整个 session 键。
- `reset-session`：删除该会话键。`reset-sessions`：`sessions = {}`。
- `source add`：`path.resolve` 后必须是已存在目录；重复→400；`remove` 不存在→400。路径统一存绝对路径。
- `managed add`：name 必须 kebab-case、description 非空且无换行；在 `managedDir/name/SKILL.md` 写入 `serializeSkill` 结果；已存在目录→400（或覆盖？**选择 400**，避免误删）。`remove`：name kebab + 目录存在，`rmSync(recursive:true)`。
- `sources` 目录里若发现技能，同样参与 provider 真实候选（rank 1）。
- 以上所有路径校验失败抛 `Error`（带 `status=400` 属性），HTTP 映射 400；其他异常 500。

### 7.4 禁用的元数据

从 `entries`/snapshot 里找该 name 的 `description`、`source`、`path`；找不到时 `description=name`、`source='unknown'`、`path=null`。字段：`{description, source, path, disabledAt}`（会话级用 `updatedAt`）。

## 8. agent 工具 `skill_switch`

```js
{
  name: 'skill_switch',
  description: 'List, enable or disable skills for the current session, or manage global defaults. Session changes override global settings.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list','set','reset_session','reset_sessions','add_source','remove_source','add_skill','remove_skill','refresh'] },
      name: { type: 'string' },
      scope: { type: 'string', enum: ['session','global'] },
      disabled: { type: 'boolean' },
      sessionId: { type: 'string' },
      cwd: { type: 'string' },
      path: { type: 'string' },
      description: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['action'],
    additionalProperties: false
  },
  output: {
    schema: { type:'object', properties:{ ok:{type:'boolean'}, message:{type:'string'}, data:{type:'object'} }, required:['ok','message'] },
    render: (args, value) => [{ type:'text', text: value.message }]
  },
  async execute(args, exec) { ... }
}
```

- `sessionId` 默认 `exec.agent?.session?.id`；`cwd` 默认 `exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal).catch(()=>undefined) : undefined`，再回退 `args.cwd`。
- action 映射到 service：`list`→list；`set`→toggle（scope 默认 `'session'`；需要 name+disabled）；`reset_session`/`reset_sessions`/`add_source`/`remove_source`/`add_skill`/`remove_skill`；`refresh`→只调 invalidate。
- `list` 的 message：多行文本，每行 `- [on|off] name (source) — description`，开头一行 `Skills for session <sid> (cwd=<cwd>)`；`set` 等返回一句结果说明。data 为 payload。
- 工具任何校验失败返回 `{ok:false,message}`（不抛错）。

## 9. client 契约（`client.js`）

自注册脚本（不是 ESM）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-skill-switch',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    // ...组件...
    return { inject: ['slots', 'locale'], apply(ctx) { /* 注册 slot + 样式 */ } }
  }
})
```

> ⚠️ **必须把 `locale` 写进 client 的 `inject`**：apply 里会读 `ctx.locale`，Cordis 对未声明 inject 的服务属性访问会抛
> `cannot get property "locale" without inject`，浏览器端插件激活失败 → DSH 启动页报
> `web boot: 1 entry did not activate` 并触发自动恢复（profile 会被重置）。2026-11-13 实测踩过。

- `apply(ctx)` 必须：
  1. 注册设置页 section：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'skill-switch', order:60, label: () => t('settingsNav') }, GlobalSection))`
  2. 注册会话 dock：`ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name:'conversation.composer.dock', id:'skill-switch', order:40, inject: (sessionId) => ({ sessionId }) }, DockChip))`
  3. 注入 `<style>`：`document.createElement('style')` + `document.head.appendChild`（守卫 `typeof document !== 'undefined'`），`ctx.effect(() => () => style.remove(), 'skill-switch-style')` 清理。
  4. 注册 locale：`ctx.locale?.register('skillSwitch','zh',zh)` / `'en'`，返回的 disposer 交给 `ctx.effect` 清理（`ctx.locale` 可能不存在，守卫）。
- `t(key, vars)`：读 `ctx.locale?.getSnapshot?.()?.active`，`zh*`→zh 字典，否则 en；变量替换 `{name}`；key 缺失回退 zh 再回退 key。
- 数据访问：`fetch('/api/skill-switch/...')`（same-origin），必须 `if (!res.ok) throw new Error(...)`；POST 用 `method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(...)`。
- 会话 cwd：`try { const sessions = ctx.get?.('sessions'); return sessions?.list?.getSnapshot?.().byId?.[sessionId]?.cwd } catch {}`；拿不到就不传 cwd（host 会回退默认目录）。
- UI 只用 `h('div'|'button'|'input'|'span'|'label'|'section'|'h3'|'p', props, children)` + 自有 CSS（CSS 变量 `--dsw-alias-*` 带回退色）；**不 require 其它包**；不做全屏 overlay。
- `DockChip`：小按钮（Pill 风格、`title` 提示），点击展开/收起面板；面板 `position:absolute; bottom:100%+8px` 挂在 `position:relative` 容器里；宽 320，max-height 60vh，内部滚动。
- 面板功能：搜索过滤；技能列表（name + 状态 badge + 本会话开关）；顶部显示当前会话 cwd 简要；底部按钮「恢复本会话默认」→ `POST /reset-session`；提示「全局开关在 设置 → 技能开关」。
- `GlobalSection`：标题+说明；工具条（刷新 / 清空所有会话改动 + 显示 `sessionsWithOverrides` 数量）；全局技能列表（开关 → `POST /toggle` scope='global'）；注入源管理（列出 + 添加输入框 + 移除按钮 → `/source`）；托管技能管理（列出 + 新建表单 name/description/content + 删除 → `/managed`）；错误提示条。
- 所有切换操作按钮 busy 时禁止重复点击；失败显示错误文本，不崩溃。
- 组件不发起 apply 时的网络请求（仅 mount 后 fetch）。

## 10. locale keys（ui-dev 必须全部实现，zh/en 同 key）

```
settingsNav, pageTitle, pageDesc, refresh, resetAllSessions, sessionsWithOverrides,
globalTitle, globalDesc, sessionTitle, sessionDesc,
sessionChip, sessionPanelTitle, sessionPanelHint, restoreSession, searchPlaceholder, noResults,
badgeDefault, badgeGlobal, badgeSession, badgeSessionEnabled,
enabled, disabled,
sourcesTitle, sourcesDesc, sourcePlaceholder, add, remove, sourceEmpty,
managedTitle, managedDesc, managedNamePlaceholder, managedDescriptionPlaceholder, managedContentPlaceholder,
create, delete, managedEmpty, missingSkill,
loading, errorPrefix, sessionCwd, openSettingsHint, confirmResetAll, confirmDeleteSkill
```

## 11. selfcheck 要求

### `scripts/selfcheck-host.mjs`（host-dev）
- 用临时目录做 `dshHome`（`os.tmpdir()` 下唯一目录），不碰真实 `~/.dsh`。
- 构造 fake ctx：`get(k)`（`dshHomePath` 返回函数 `(...s)=>join(tmp,...s)`；`workingDirectory.defaultDirectory`；`agents.get` 返回 undefined）、`skills.registerProvider(fn)` 捕获 provider、`tools.register` 捕获工具、`webServer.register(route)` 捕获 route、`effect(fn){return fn()}`、`logger`。
- 运行 `apply(fakeCtx,{})` 不抛错；断言 provider.name === 'skill-switch'；工具名 `skill_switch`；route.path === '/api/skill-switch'。
- 行为断言：
  1. 在 `tmpHome/skills/alpha/SKILL.md` 写入带 frontmatter 的技能；`discoverSkills` 能解析 name/description/invocation。
  2. `effective` 四条规则（默认 / global disabled / session disabled / session enabled 优先于 global）。
  3. `toggle`：全局禁用 alpha → `provider.list({cwd:workspace})` 返回 rank 0、双 invocation=false 的 alpha；session 显式启用 → 返回 rank 1 真实候选；reset-session 后回到 rank 0。
  4. managed skill add → `$DSH_HOME/skill-switch/skills/<name>/SKILL.md` 存在，provider.list 输出 rank 1。
  5. source add → 该目录技能出现在 list payload（`service.list({cwd})`）。
  6. `resetSessions` 清空 sessions。
  7. HTTP handler：用 fake `req`（`url`, `method:'GET'`, `on` 事件）与 fake `res`（`writeHead`, `end` 收集）请求 `/state?...`，断言 200 且 payload 字段齐全。若实现复杂可只测 GET；POST 由 verifier 补。
- 结束打印 `PASS host`，失败 `process.exit(1)`。

### `scripts/selfcheck-client.mjs`（ui-dev）
- 构造 `globalThis.window.__ModuleLoader__ = { load(spec){ captured = spec } }`；`await import('../client.js')`；断言 `captured.id === 'dsh-skill-switch'` 且 factory 是函数。
- fake React：`createElement: (type, props, ...children) => ({type, props, children})`，`useState: (v)=>[v,()=>{}]`，`useEffect: ()=>{}`，`useMemo:(f)=>f()`，`Fragment:'Fragment'`。
- fake document：`createElement` 返回 `{remove(){}, setAttribute(){}, textContent:''}`，`head.appendChild` 记录；`body.appendChild` 同理。
- fake ctx：`slots.inject(name, fn){fn()}`、`slots.register(opts, Component){capturedSlots.push({...opts, Component})}`、`effect(fn){try{return fn()}catch{}}`、`get(k)`、`locale.register(){return ()=>{}}`、`locale.getSnapshot(){return {active:'zh'}}`。
- 断言：注册了 `settings.section` 与 `conversation.composer.dock` 两个 slot（id 均含 `skill-switch`），`composer.dock` 注册项的 `inject` 是函数；至少 append 一个 style；`apply` 不抛错。
- 结束打印 `PASS client`。

### `scripts/selfcheck.mjs`（verifier）
- 依次 `node scripts/selfcheck-host.mjs`、`node scripts/selfcheck-client.mjs`（子进程，继承 stdio）。
- 静态检查：`package.json` 字段（name/type/main/exports/dsh.bundle.patch/dsh.client）；`cordis.patch.yml` 含 id/name；locale zh/en JSON 可解析且 key 集合相同；`lib/*.js`、`index.js`、`client.js` 无第三方 import；`index.js` 含 `registerProvider`、`skill_switch`、`/api/skill-switch`。
- 全部通过打印 `ALL PASS`。

## 12. 完成判定

- `node scripts/selfcheck.mjs` 输出 `ALL PASS`。
- host-dev / ui-dev 各自 `scripts/selfcheck-*.mjs` 单独通过。
- 无跨所有权文件改动（`git status` 或文件清单核对）。
- 交回 Lead：改动文件列表、selfcheck 输出、任何未决风险。
