# dsh-skill-switch 使用说明

给「人」看的说明：怎么用、怎么装、状态存在哪、出问题看哪里。
（技能页面里那行中文注释由插件 UI 自带，**不会**写进 SKILL.md，模型看不到。）

## 1. 这是什么

一个 DeepSeek Harness 插件，给每个技能加一个开关：

- **全局默认**：在「设置 → 技能开关」里统一定义哪些技能默认加载。
- **单会话覆盖**：在会话输入框下方的「技能」胶囊里，只对当前会话开/关技能。
- **会话优先**：同一个技能，会话里的改动永远压过全局默认。
- **一键恢复**：可以清空某个会话的覆盖，也可以一键清空所有会话的覆盖（全局默认保留）。

关掉的技能会同时从两处消失：模型看到的技能目录，以及 `/` 斜杠菜单。

## 2. 安装 / 卸载

本机（desktop profile）已经装好：`package.json` 里有
`dsh-skill-switch: link:<插件目录>`，`dsh.profile.bundles` 里有 `dsh-skill-switch`。

新机器安装：

```powershell
# 1) 把包加进 profile（只是 pnpm add）
dsh plugin --profile <profile> add link:<插件绝对目录>

# 2) 确认 profile 的 package.json 的 dsh.profile.bundles 里出现 dsh-skill-switch
#    （CLI 不会自动写 bundles；plugin_manager 才会）

# 3) 重启 DSH（无 HMR 时配置只在启动时装载）
```

注意：desktop profile 由 Electron 应用托管，`dsh plugin --profile desktop ...` 可能被拒
（`managed exclusively by the Electron application`）；此时按上面的方式手动改
`%USERPROFILE%\.dsh\profiles\desktop\package.json` 并建好 `node_modules` 链接即可。

卸载：从 `dsh.profile.bundles` 与 `dependencies` 里移除 `dsh-skill-switch`，重启 DSH。
状态文件与托管技能目录不会自动删除，需要的话手动删 `%USERPROFILE%\.dsh\skill-switch\`。

## 3. 日常使用

### 全局默认

「设置 → 技能开关」：

- **全局默认**：每个技能一个开关，决定所有会话的默认值。
- **会话覆盖**：显示有多少会话改过；「清空所有会话改动」把全部会话恢复成全局默认。
- **技能来源目录**：把额外目录里的技能也纳管（每技能一个子目录，或一个 `.md` 文件）。
- **托管技能**：直接在插件数据目录里新建一个小技能（名字 + 一句话描述 + Markdown 正文）。

### 单会话

会话输入框下面有「技能」小胶囊 → 点开面板：

- 列出当前会话所有技能及来源（user / bundled / 自定义目录 / 托管）；
- 每个技能可单独开/关，只影响当前会话；
- 「恢复本会话默认」清掉这个会话的全部覆盖；
- 搜索框可以按技能名、英文描述、中文注释搜。

### 优先级

同一个技能最终是否加载，按这个顺序判定：

1. 会话里显式「开」→ 启用
2. 会话里显式「关」→ 禁用
3. 全局默认里「关」→ 禁用
4. 都没有 → 启用（按技能自身 frontmatter）

## 4. 技能来源

插件按下面的顺序扫描（同一技能同名时，靠前/更高优先的赢）：

| 来源 | 路径 |
| --- | --- |
| 托管技能 | `%USERPROFILE%\.dsh\skill-switch\skills\<name>\SKILL.md` |
| 自定义来源目录 | 设置页「技能来源目录」里添加的路径 |
| 项目级 | `<cwd>/.dsh/skills`、`<cwd>/.agents/skills` |
| 用户级 | `%USERPROFILE%\.dsh\skills`（跳过 `.system`） |
| 内置 | DSH 自带的 bundled 技能（如 office 系列） |

只扫一层：`<name>/SKILL.md` 或顶层 `<name>.md`。
项目级来源需要知道会话的 cwd：会话面板会带 cwd，工具调用用 `workingDirectory` 服务。

## 5. 技能页面里的中文注释

「设置 → 技能开关」里每个技能英文描述下面那行浅灰中文，是**本机 UI 专用**的注释：

- 数据在 `client.js` 的 `SKILL_NOTES` 表里（技能名 → 一句话）；
- 不写进任何 `SKILL.md`，也不进 provider 的 description，所以**模型读不到**；
- 新增自定义/托管技能默认没有注释，想加就在 `SKILL_NOTES` 里补一行，刷新页面即可。

## 6. 状态与数据

| 内容 | 位置 |
| --- | --- |
| 开关状态 | `%USERPROFILE%\.dsh\skill-switch\state.json` |
| 托管技能 | `%USERPROFILE%\.dsh\skill-switch\skills\` |
| 插件数据目录 | `%USERPROFILE%\.dsh\skill-switch\` |

`state.json` 结构（version 1）：

```json
{
  "version": 1,
  "global": { "disabled": { "<name>": { "description": "...", "source": "...", "disabledAt": "..." } } },
  "sessions": {
    "<sessionId>": {
      "enabled":  { "<name>": { "updatedAt": "..." } },
      "disabled": { "<name>": { "updatedAt": "..." } },
      "updatedAt": "..."
    }
  },
  "sources": [ { "path": "D:\\my-skills", "addedAt": "..." } ]
}
```

写入使用临时文件 + rename 的原子方式；文件损坏时会改名为 `.bak` 再重建。
改状态后插件会调用 `invalidate()`，下一条模型步的技能目录随之刷新。

## 7. HTTP API 与 agent 工具

设置页/会话面板都走同源 HTTP：

| 方法 / 路径 | 作用 |
| --- | --- |
| `GET /api/skill-switch/state?sessionId=&cwd=` | 当前状态 + 技能列表 + 来源 + 托管技能 |
| `POST /api/skill-switch/toggle` | `{name, scope:"session"\|"global", disabled, sessionId?, cwd?}` |
| `POST /api/skill-switch/reset-session` | `{sessionId}` 清当前会话覆盖 |
| `POST /api/skill-switch/reset-sessions` | 清全部会话覆盖 |
| `POST /api/skill-switch/source` | `{action:"add"\|"remove", path}` |
| `POST /api/skill-switch/managed` | `{action:"add"\|"remove", name, description?, content?}` |

统一返回 `{ok:true,...}`；错误返回 400/404/500 与 `{ok:false,error}`。
agent 侧工具 `skill_switch` 提供同一组操作：
`list / set / reset_session / reset_sessions / add_source / remove_source / add_skill / remove_skill / refresh`。

## 8. 已知限制

- **agent-preset 作用域**的技能无法被屏蔽（技能注册表里最近层直接赢，插件只能覆盖 global 层）。
- 空闲会话的 `/` 斜杠菜单走 `skills/list` RPC，可能拿不到会话作用域而短暂显示全局默认；模型目录走 pre-step，是准的。
- 项目级技能依赖 cwd；拿不到 cwd 时只列用户级/内置技能。
- 改 `client.js` 需要刷新页面（F5）；改 host 侧（`index.js`、`lib/`）需要重启 DSH。

## 9. 排障

- 客户端插件挂掉会让整个 Web boot 失败：看
  `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`。
- DSH 启动失败后可能自动重置 profile：原配置会被备份成
  `cordis.patch.yml.bak-*`、`package.json.bak-*`，从备份恢复后再重启。
- 改完代码先跑自检：

```powershell
cd <插件目录>
node scripts/selfcheck.mjs        # 汇总：host + client 全跑
node scripts/selfcheck-host.mjs   # 只跑 host
node scripts/selfcheck-client.mjs # 只跑 client
```

全部通过时尾部会打印 `ALL PASS` / `PASS host` / `PASS client`。
