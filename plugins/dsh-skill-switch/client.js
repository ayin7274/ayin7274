/**
 * dsh-skill-switch —— 浏览器半端（设置页 section + 会话输入框 dock 面板）
 * ============================================================================
 * 这是**自注册脚本**，不是 ESM：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                    // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject: ['slots', 'locale'], apply(ctx) { ... } }),
 *     })
 *
 * 契约（SPEC §9 / §10）：
 *   · apply 注册两个 slot：settings.section（设置 → 技能开关）与
 *     conversation.composer.dock（输入框下方的「技能」小胶囊 + 锚定面板）。
 *   · 所有 HTTP 都走同源 /api/skill-switch/*，一律检查 res.ok 并展示服务端错误文本。
 *   · apply 里不发网络请求；组件 mount 之后才 fetch。
 *   · UI 只用 div/button/input/span/label/section/h3/p + 自有 CSS，不 require 其它包。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-switch',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/skill-switch'
    const LOCALE_NS = 'skillSwitch'
    const STYLE_ATTR = 'dsh-skill-switch'

    /* ────────────────── 中文注释（只给本机 UI 看，不进模型目录） ──────────────────
     * 这些说明只渲染在「技能开关」页面/会话面板里；不写进任何 SKILL.md，
     * 也不会进入技能的 description/正文，所以模型既看不到、也读不到。
     * key = 技能名；未收录的技能不显示注释（页面照常工作）。
     * ─────────────────────────────────────────────────────────────── */
    const SKILL_NOTES = {
      'code-review': '从固定基点审改动：仓库规范（Standards）与需求符合度（Spec）双轴并行。',
      'diagnosing-bugs': '难 bug / 性能回归的诊断循环：复现 → 定位 → 验证修复。',
      'tdd': '测试驱动开发：先红、再绿、后重构，含集成测试。',
      'improve-codebase-architecture': '扫描代码库找「可加深模块」的改造机会，产出可视化报告。',
      'codebase-design': '深模块设计的共享词汇：模块接口、seam、可测性与可导航性。',
      'domain-modeling': '打磨领域模型：术语表 GLOSSARY.md、ADR 与边界讨论。',
      'prototype': '写一次性原型回答设计问题，验证状态模型或 UI 方向。',
      'grilling': '就一个计划 / 决策 / 想法连续追问，往死里拷问。',
      'grill-me': '轻量高压面试：只提问打磨，不产出文档。',
      'grill-with-docs': '高压面试 + 把决策落成 ADR 和术语表。',
      'implement': '按 spec 或一组 ticket 实现一块工作。',
      'implement-spec': '实现 /to-spec 与 /to-tickets 的产物，走完整 spec 流程。',
      'to-spec': '把当前对话综合成 spec 并发布到 issue tracker（不做访谈）。',
      'to-tickets': '把 plan/spec 拆成 tracer-bullet 票，声明阻塞边并发布。',
      'pr': '写 PR 正文：背景、改动、验证、风险。',
      'triage': 'issue / 外部 PR 的分诊状态机：分类、验证、必要时 grill、写 brief。',
      'wayfinder': '把超大会话容量的工作规划成 issue tracker 上的决策票地图。',
      'setup-matt-pocock-skills': '一次性仓库配置：issue tracker、triage 标签、文档布局。',
      'handoff': '把当前会话压成交接文档，让另一个 agent / 新会话接手。',
      'retro': '对一次编码会话做回顾：做对什么、卡在哪、下次怎么改。',
      'wait-what': '明确要求重讲：刚才那段没让我理解 / 没落地。',
      'ask-matt': '技能路由器：根据当前处境告诉你该用哪个技能 / 流程。',
      'teach': '在当前工作区里结合项目内容教你一个新技能 / 概念。',
      'research': '查高可信一手来源，把结论写成仓库 Markdown 调研文档。',
      'writing-for-agents': '写「给 agent 看」的文档：skill、AGENTS.md、CLAUDE.md。',
      'to-questionnaire': '把无法自答的决策转成问卷，交给别人填。',
      'wizard': '生成交互式 bash 向导，带人走只有人能做的步骤。',
      'office': 'Office / PDF 总入口：先选对工作流，再进具体子技能。',
      'office-docx': 'Word 文档（.docx）的创建、读取、编辑与校验。',
      'office-xlsx': 'Excel 工作簿（.xlsx）的读取、创建、编辑与公式校验。',
      'office-pptx': 'PowerPoint（.pptx）的创建、读取、编辑与校验。',
      'office-render': '用 LibreOffice Kit 渲染文档图像、检查视觉排版。',
      'office-recalculate': '刷新电子表格公式缓存并核对计算值。',
      'office-export-pdf': '把 Office 文档转换成指定 PDF。',
    }
    const noteOf = (name) => SKILL_NOTES[String(name || '')] || ''

    /* ────────────────────────── 文案字典 ──────────────────────────
     * 与 locale/zh.json、locale/en.json 逐字一致（selfcheck-client 会比对），
     * 因为 client bundle 不能读 JSON 文件，只能内联一份。
     * ────────────────────────────────────────────────────────────── */
    /* locale:zh:start */
    const ZH = {
      "settingsNav": "技能开关",
      "pageTitle": "技能开关",
      "pageDesc": "控制每个会话可以加载哪些技能。会话内的改动优先于全局默认，也可以一键全部恢复。",
      "refresh": "刷新",
      "resetAllSessions": "清空所有会话改动",
      "sessionsWithOverrides": "有改动的会话：{count}",
      "globalTitle": "全局默认",
      "globalDesc": "这里是所有会话的默认开关；单个会话可以在输入框下方的「技能」面板里覆盖。",
      "sessionTitle": "会话覆盖",
      "sessionDesc": "会话内的开关优先于全局默认。",
      "sessionChip": "技能",
      "sessionPanelTitle": "本会话技能",
      "sessionPanelHint": "下面的开关只影响当前会话。",
      "restoreSession": "恢复本会话默认",
      "searchPlaceholder": "搜索技能",
      "noResults": "没有匹配的技能",
      "badgeDefault": "默认",
      "badgeGlobal": "全局关",
      "badgeSession": "会话关",
      "badgeSessionEnabled": "会话开",
      "enabled": "已启用",
      "disabled": "已禁用",
      "sourcesTitle": "技能来源目录",
      "sourcesDesc": "把这些目录里的技能一起加载（每个技能一个子目录，或一个 .md 文件）。",
      "sourcePlaceholder": "目录绝对路径，如 D:\\my-skills",
      "add": "添加",
      "remove": "移除",
      "sourceEmpty": "还没有添加来源目录。",
      "managedTitle": "托管技能",
      "managedDesc": "直接写在插件数据目录里的技能，创建后马上可用。",
      "managedNamePlaceholder": "技能名（kebab-case，如 my-skill）",
      "managedDescriptionPlaceholder": "一句话描述（不能换行）",
      "managedContentPlaceholder": "技能正文（Markdown）",
      "create": "创建",
      "delete": "删除",
      "managedEmpty": "还没有托管技能。",
      "missingSkill": "文件缺失",
      "loading": "加载中…",
      "errorPrefix": "出错了：",
      "sessionCwd": "工作目录",
      "openSettingsHint": "全局开关在 设置 → 技能开关",
      "confirmResetAll": "清空所有会话的技能改动？",
      "confirmDeleteSkill": "删除这个托管技能？"
    }
    /* locale:zh:end */
    /* locale:en:start */
    const EN = {
      "settingsNav": "Skill Switch",
      "pageTitle": "Skill Switch",
      "pageDesc": "Choose which skills each session can load. Session changes override the global defaults and can be reset at any time.",
      "refresh": "Refresh",
      "resetAllSessions": "Reset all session changes",
      "sessionsWithOverrides": "Sessions with changes: {count}",
      "globalTitle": "Global defaults",
      "globalDesc": "These switches are the defaults for every session. A single session can override them from the Skills panel under the composer.",
      "sessionTitle": "Session overrides",
      "sessionDesc": "Session switches take priority over the global defaults.",
      "sessionChip": "Skills",
      "sessionPanelTitle": "Skills in this session",
      "sessionPanelHint": "Switches below only affect the current session.",
      "restoreSession": "Restore session defaults",
      "searchPlaceholder": "Search skills",
      "noResults": "No matching skills",
      "badgeDefault": "Default",
      "badgeGlobal": "Global off",
      "badgeSession": "Session off",
      "badgeSessionEnabled": "Session on",
      "enabled": "Enabled",
      "disabled": "Disabled",
      "sourcesTitle": "Skill source folders",
      "sourcesDesc": "Load skills from additional folders (one subfolder or one .md file per skill).",
      "sourcePlaceholder": "Absolute folder path, e.g. D:\\my-skills",
      "add": "Add",
      "remove": "Remove",
      "sourceEmpty": "No source folders yet.",
      "managedTitle": "Managed skills",
      "managedDesc": "Skills written into the plugin data folder. They are available immediately.",
      "managedNamePlaceholder": "Skill name (kebab-case, e.g. my-skill)",
      "managedDescriptionPlaceholder": "One-line description (no newlines)",
      "managedContentPlaceholder": "Skill body (Markdown)",
      "create": "Create",
      "delete": "Delete",
      "managedEmpty": "No managed skills yet.",
      "missingSkill": "File missing",
      "loading": "Loading…",
      "errorPrefix": "Error: ",
      "sessionCwd": "Working directory",
      "openSettingsHint": "Global switches are in Settings → Skill Switch",
      "confirmResetAll": "Reset skill changes for all sessions?",
      "confirmDeleteSkill": "Delete this managed skill?"
    }
    /* locale:en:end */

    /* ────────────────────────── 样式 ──────────────────────────
     * 全部用 --dsw-alias-* token（带回退色），跟随主题明暗变化。
     * 属性选择器 data-ss-* 避免和宿主 CSS 撞名。
     * ────────────────────────────────────────────────────────── */
    const CSS = `
[data-ss-page]{display:flex;flex-direction:column;gap:18px;max-width:720px;padding:2px 2px 12px;
  font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e8e8ea);}
/* 不透明表面：bg 系 token 本身就是不透明底色；再用 label 色按百分比 color-mix 出层次，
   混出来的颜色依旧不透明 —— 面板/卡片不会透出背后内容。 */
[data-ss-page],[data-ss-dock]{
  --ss-surface-0:var(--dsw-alias-bg-base,#fff);
  --ss-surface-1:var(--dsw-alias-bg-layer-2,var(--ss-surface-0));
  --ss-surface-2:var(--dsw-alias-bg-layer-3,var(--ss-surface-0));
  --ss-surface-hover:var(--dsw-alias-bg-layer-3,var(--ss-surface-0));
}
@supports (background:color-mix(in srgb,red 5%,white)){
  [data-ss-page],[data-ss-dock]{
    --ss-surface-1:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 3%,var(--ss-surface-0));
    --ss-surface-2:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 5%,var(--ss-surface-0));
    --ss-surface-hover:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 9%,var(--ss-surface-0));
  }
}
[data-ss-head]{display:flex;flex-direction:column;gap:4px;}
[data-ss-head-row]{display:flex;align-items:flex-start;gap:12px;}
[data-ss-grow]{flex:1;min-width:0;}
[data-ss-title]{margin:0;font-size:16px;line-height:24px;font-weight:600;}
[data-ss-desc]{margin:2px 0 0;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary,#b8bbc0);}
[data-ss-toolbar]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-ss-count]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-sec]{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));
  background:var(--ss-surface-1);}
[data-ss-h]{margin:0;font-size:13px;line-height:20px;font-weight:600;}
[data-ss-sub]{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-row]{display:flex;align-items:center;gap:10px;min-height:30px;padding:3px 0;}
[data-ss-row]+[data-ss-row]{border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));}
[data-ss-name]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;
  font-size:13px;line-height:20px;}
[data-ss-name-text]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-ss-note]{font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-zh]{margin-top:1px;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-secondary,#b8bbc0);overflow-wrap:anywhere;}
[data-ss-path]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-secondary,#b8bbc0);}
[data-ss-badge]{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:999px;
  font-size:10px;line-height:16px;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary,#b8bbc0);}
[data-ss-badge][data-tone="global"]{color:var(--dsw-alias-state-warning-primary,#e0a83a);
  background:rgba(224,168,58,.14);}
[data-ss-badge][data-tone="session"]{color:var(--dsw-alias-state-business-primary,#6ea8fe);
  background:rgba(110,168,254,.14);}
[data-ss-badge][data-tone="enabled"]{color:var(--dsw-alias-state-success-primary,#4ec97a);
  background:rgba(78,201,122,.14);}
[data-ss-badge][data-tone="warn"]{color:var(--dsw-alias-state-warning-primary,#e0a83a);
  background:rgba(224,168,58,.14);}
[data-ss-state]{margin-left:6px;font-size:10px;line-height:16px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-sw]{position:relative;flex:none;width:34px;height:20px;padding:0;border:0;border-radius:10px;
  cursor:pointer;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));
  transition:background .15s;}
[data-ss-sw][data-on]{background:var(--dsw-alias-state-business-primary,#3b82f6);}
[data-ss-sw] i{position:absolute;top:3px;left:3px;display:block;width:14px;height:14px;
  border-radius:50%;background:#fff;transition:left .15s;}
[data-ss-sw][data-on] i{left:17px;}
[data-ss-sw][disabled]{opacity:.45;cursor:default;}
[data-ss-btn]{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;
  padding:0 11px;border-radius:8px;font-family:inherit;font-size:12px;line-height:1;cursor:pointer;
  white-space:nowrap;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));
  background:var(--ss-surface-1);
  color:var(--dsw-alias-label-primary,#e8e8ea);}
[data-ss-btn]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-ss-btn][disabled]{opacity:.45;cursor:default;}
[data-ss-btn][data-ss-primary]{background:var(--dsw-alias-state-business-primary,#3b82f6);
  border-color:transparent;color:#fff;}
[data-ss-btn][data-ss-danger]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#f2a1a1);
  border-color:var(--dsw-alias-state-error-primary,#f2a1a1);background:transparent;}
[data-ss-btn][data-ss-block]{width:100%;}
[data-ss-input]{flex:1;min-width:0;box-sizing:border-box;height:28px;padding:0 9px;border-radius:8px;
  font-family:inherit;font-size:12px;line-height:1;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));
  background:var(--ss-surface-0);color:inherit;}
[data-ss-input]::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-input]:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3b82f6);}
[data-ss-inline]{display:flex;align-items:center;gap:8px;}
[data-ss-form]{display:flex;flex-direction:column;gap:8px;}
[data-ss-msg]{padding:7px 10px;border-radius:8px;font-size:11px;line-height:16px;word-break:break-word;
  background:var(--ss-surface-1);
  color:var(--dsw-alias-label-secondary,#b8bbc0);}
[data-ss-msg][data-warn]{color:var(--dsw-alias-state-error-primary,#f2a1a1);}
[data-ss-empty]{padding:6px 0;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-hint]{font-size:10px;line-height:14px;text-align:center;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}

/* ── composer dock：胶囊 + 锚定面板（不做全屏 overlay） ── */
[data-ss-dock]{position:relative;display:inline-flex;align-items:center;align-self:center;flex:none;}
[data-ss-chip]{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;
  border-radius:999px;font-family:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:var(--ss-surface-1);
  color:var(--dsw-alias-label-secondary,#b8bbc0);transition:background .15s,color .15s;}
[data-ss-chip]:hover,[data-ss-chip][data-open]{background:var(--ss-surface-hover);
  color:var(--dsw-alias-label-primary,#e8e8ea);}
[data-ss-chip-count]{font-variant-numeric:tabular-nums;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-chip-caret]{display:inline-block;font-size:9px;line-height:1;transition:transform .15s;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-chip][data-open] [data-ss-chip-caret]{transform:rotate(180deg);}
[data-ss-panel]{position:absolute;right:0;bottom:calc(100% + 8px);z-index:1000;display:flex;
  flex-direction:column;width:320px;max-width:calc(100vw - 24px);max-height:60vh;overflow:hidden;
  border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));
  background:var(--ss-surface-2);
  backdrop-filter:none;-webkit-backdrop-filter:none;
  box-shadow:var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.35));}
[data-ss-panel-head]{display:flex;flex-direction:column;gap:6px;padding:10px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));}
[data-ss-panel-title]{font-size:12px;line-height:18px;font-weight:600;}
[data-ss-cwd]{font-size:10px;line-height:14px;word-break:break-all;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ss-panel-scroll]{flex:1;min-height:0;overflow-y:auto;padding:4px 6px;}
[data-ss-dock-row]{padding:5px 4px;}
[data-ss-panel-foot]{display:flex;flex-direction:column;gap:6px;padding:8px 10px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));}
`

    /* ────────────────────────── HTTP ────────────────────────── */

    const errorTextOf = (error) => {
      if (error === undefined || error === null) return 'unknown error'
      const message = error && error.message ? error.message : error
      return String(message)
    }

    // 从失败响应里抠出服务端 error 文本（越详细越好）
    const describeFailure = async (res) => {
      let detail = ''
      try {
        const text = await res.text()
        if (text) {
          try {
            const parsed = JSON.parse(text)
            detail = (parsed && (parsed.error || parsed.message)) || text
          } catch (parseError) {
            detail = text
          }
        }
      } catch (readError) {
        detail = ''
      }
      detail = String(detail || '').trim()
      return 'HTTP ' + res.status + (detail ? ': ' + detail : '')
    }

    const asJson = async (res) => {
      if (!res || typeof res.ok !== 'boolean') throw new Error('bad response from server')
      if (!res.ok) throw new Error(await describeFailure(res))
      let data
      try {
        data = await res.json()
      } catch (parseError) {
        throw new Error('invalid JSON response from server')
      }
      if (!data || typeof data !== 'object') throw new Error('empty response from server')
      return data
    }

    const expectOk = (data) => {
      if (!data || data.ok === false) {
        throw new Error((data && (data.error || data.message)) || 'request failed')
      }
      return data
    }

    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }))

    const jpost = async (path, body) => asJson(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const buildQuery = (params) => {
      const parts = []
      const source = params || {}
      for (const key of Object.keys(source)) {
        const value = source[key]
        if (value === undefined || value === null || value === '') continue
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      }
      return parts.length ? '?' + parts.join('&') : ''
    }

    const fetchState = async (params) => {
      const query = buildQuery({
        sessionId: params && params.sessionId,
        cwd: params && params.cwd,
      })
      return expectOk(await jget('/state' + query))
    }

    const normalize = (data) => (data && typeof data === 'object' ? data : {})

    // 会话 cwd：只有拿得到才传，拿不到就省略（host 会回退默认工作目录）
    const sessionCwd = (ctx, sessionId) => {
      if (!sessionId) return undefined
      try {
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return undefined
        const snapshot = sessions.list.getSnapshot()
        const record = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined
        const cwd = record && record.cwd
        return typeof cwd === 'string' && cwd ? cwd : undefined
      } catch (error) {
        return undefined
      }
    }

    const confirmAction = (text) => {
      try {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(text)
      } catch (error) {
        /* 没有 confirm 就直接执行 */
      }
      return true
    }

    /* ────────────────────────── 文案解析 ────────────────────────── */

    const activeLocale = (ctx) => {
      try {
        const locale = ctx && ctx.locale
        const snapshot = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined
        const active = snapshot && snapshot.active
        return typeof active === 'string' ? active : ''
      } catch (error) {
        return ''
      }
    }

    const translate = (ctx, key, vars) => {
      const lang = activeLocale(ctx).toLowerCase()
      const dict = lang.indexOf('zh') === 0 ? ZH : EN
      let text = dict[key]
      if (typeof text !== 'string') text = ZH[key]
      if (typeof text !== 'string') text = key
      if (vars) {
        text = text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
          vars[name] === undefined || vars[name] === null ? match : String(vars[name])
        ))
      }
      return text
    }

    /* ────────────────────────── 组件 ────────────────────────── */

    const createUI = (ctx) => {
      const t = (key, vars) => translate(ctx, key, vars)

      // 语言切换时重渲染（locale 可能不存在 / 没有 subscribe，全守卫）
      const useLocaleRefresh = () => {
        const [, force] = React.useState(0)
        React.useEffect(() => {
          const locale = ctx && ctx.locale
          if (!locale || typeof locale.subscribe !== 'function') return undefined
          let off
          try {
            off = locale.subscribe(() => force((value) => value + 1))
          } catch (error) {
            return undefined
          }
          return () => {
            try {
              if (typeof off === 'function') off()
            } catch (error) {
              /* ignore */
            }
          }
        }, [])
      }

      const Switch = (props) => {
        const on = Boolean(props && props.on)
        const disabled = Boolean(props && props.disabled)
        const onChange = props && props.onChange
        return h('button', {
          type: 'button',
          'data-ss-sw': '',
          'data-on': on ? '' : undefined,
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          disabled: disabled,
          title: (props && props.title) || (on ? t('enabled') : t('disabled')),
          onClick: () => {
            if (!disabled && typeof onChange === 'function') onChange(!on)
          },
        }, h('i'))
      }

      const badgeOf = (reason) => {
        if (reason === 'global') return { key: 'badgeGlobal', tone: 'global' }
        if (reason === 'session-enabled') return { key: 'badgeSessionEnabled', tone: 'enabled' }
        if (reason === 'session-disabled') return { key: 'badgeSession', tone: 'session' }
        return { key: 'badgeDefault', tone: 'none' }
      }

      /* ── 会话 dock：小胶囊 + 锚定面板 ── */
      const DockChip = (props) => {
        useLocaleRefresh()
        const sessionId = props && props.sessionId !== undefined ? props.sessionId : undefined
        const [open, setOpen] = React.useState(false)
        const [data, setData] = React.useState(null)
        const [loading, setLoading] = React.useState(false)
        const [busy, setBusy] = React.useState('')
        const [error, setError] = React.useState('')
        const [query, setQuery] = React.useState('')
        const [reloadTick, setReloadTick] = React.useState(0)

        React.useEffect(() => {
          let alive = true
          setLoading(true)
          setError('')
          fetchState({ sessionId: sessionId, cwd: sessionCwd(ctx, sessionId) })
            .then((payload) => {
              if (alive) setData(normalize(payload))
            })
            .catch((failure) => {
              if (alive) setError(errorTextOf(failure))
            })
            .finally(() => {
              if (alive) setLoading(false)
            })
          return () => {
            alive = false
          }
        }, [sessionId, reloadTick])

        // 面板打开时：点外面 / 按 Esc 收起
        React.useEffect(() => {
          if (!open) return undefined
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onPointerDown = (event) => {
            const target = event && event.target
            if (target && typeof target.closest === 'function' && target.closest('[data-ss-dock]')) return
            setOpen(false)
          }
          const onKeyDown = (event) => {
            if (event && (event.key === 'Escape' || event.key === 'Esc')) setOpen(false)
          }
          document.addEventListener('mousedown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open])

        const toggleSkill = async (skill, nextOn) => {
          if (busy || !sessionId) return
          setBusy(String(skill && skill.name))
          setError('')
          try {
            const payload = expectOk(await jpost('/toggle', {
              name: skill && skill.name,
              scope: 'session',
              sessionId: sessionId,
              cwd: sessionCwd(ctx, sessionId),
              disabled: !nextOn,
            }))
            setData(normalize(payload))
          } catch (failure) {
            setError(errorTextOf(failure))
          } finally {
            setBusy('')
          }
        }

        const restoreSession = async () => {
          if (busy || !sessionId) return
          setBusy('__restore__')
          setError('')
          try {
            const payload = expectOk(await jpost('/reset-session', {
              sessionId: sessionId,
              cwd: sessionCwd(ctx, sessionId),
            }))
            setData(normalize(payload))
          } catch (failure) {
            setError(errorTextOf(failure))
          } finally {
            setBusy('')
          }
        }

        const skills = data && Array.isArray(data.skills) ? data.skills : []
        const needle = String(query || '').trim().toLowerCase()
        const visible = needle
          ? skills.filter((skill) => {
            const name = String((skill && skill.name) || '').toLowerCase()
            const description = String((skill && skill.description) || '').toLowerCase()
            const zh = noteOf(skill && skill.name).toLowerCase()
            return name.indexOf(needle) !== -1 || description.indexOf(needle) !== -1 || zh.indexOf(needle) !== -1
          })
          : skills
        const disabledCount = skills.reduce((count, skill) => (
          count + (skill && skill.enabled === false ? 1 : 0)
        ), 0)
        const totalCount = skills.length
        const cwd = (data && data.cwd) || sessionCwd(ctx, sessionId)
        const sessionLocked = !sessionId

        const renderRow = (skill) => {
          const on = skill && skill.enabled !== false
          const reason = skill && skill.reason
          const badge = badgeOf(reason)
          const source = String((skill && skill.source) || 'unknown')
          const zh = noteOf(skill && skill.name)
          return h('div', {
            'data-ss-row': '',
            'data-ss-dock-row': '',
            key: 'dock-skill:' + String((skill && skill.name) || ''),
            title: skill && skill.description ? String(skill.description) : undefined,
          },
            h('div', { 'data-ss-grow': '' },
              h('div', { 'data-ss-name': '' },
                h('span', { 'data-ss-name-text': '' }, String((skill && skill.name) || '')),
                reason && reason !== 'default'
                  ? h('span', { 'data-ss-badge': '', 'data-tone': badge.tone }, t(badge.key))
                  : null,
                skill && skill.missing
                  ? h('span', { 'data-ss-badge': '', 'data-tone': 'warn' }, t('missingSkill'))
                  : null
              ),
              zh ? h('div', { 'data-ss-zh': '' }, zh) : null,
              h('div', { 'data-ss-sub': '' },
                h('span', { 'data-ss-badge': '', 'data-tone': 'none' }, source),
                h('span', { 'data-ss-state': '' }, on ? t('enabled') : t('disabled'))
              )
            ),
            h(Switch, {
              on: on,
              disabled: Boolean(busy) || sessionLocked,
              title: on ? t('disabled') : t('enabled'),
              onChange: (next) => toggleSkill(skill, next),
            })
          )
        }

        const chip = h('button', {
          type: 'button',
          'data-ss-chip': '',
          'data-open': open ? '' : undefined,
          title: t('sessionPanelTitle') + (disabledCount > 0 ? ' · ' + t('disabled') + ' ' + disabledCount : ''),
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => {
            if (!open) setReloadTick((value) => value + 1)
            setOpen(!open)
          },
        },
          h('span', { 'data-ss-chip-label': '' }, t('sessionChip')),
          data ? h('span', { 'data-ss-chip-count': '' }, String(totalCount)) : null,
          h('span', { 'data-ss-chip-caret': '', 'aria-hidden': 'true' }, '▾')
        )

        const panel = open ? h('div', {
          'data-ss-panel': '',
          role: 'dialog',
          'aria-label': t('sessionPanelTitle'),
        },
          h('div', { 'data-ss-panel-head': '' },
            h('div', { 'data-ss-panel-title': '' }, t('sessionPanelTitle')),
            h('div', { 'data-ss-sub': '' }, t('sessionPanelHint')),
            cwd ? h('div', { 'data-ss-cwd': '' }, t('sessionCwd') + ': ' + String(cwd)) : null,
            h('input', {
              'data-ss-input': '',
              'data-ss-search': '',
              type: 'search',
              value: query,
              placeholder: t('searchPlaceholder'),
              onChange: (event) => setQuery(event && event.target ? event.target.value : ''),
            })
          ),
          h('div', { 'data-ss-panel-scroll': '' },
            loading && !data ? h('div', { 'data-ss-empty': '' }, t('loading')) : null,
            !loading && visible.length === 0 ? h('div', { 'data-ss-empty': '' }, t('noResults')) : null,
            visible.map(renderRow)
          ),
          error ? h('div', { 'data-ss-msg': '', 'data-warn': '' }, t('errorPrefix') + error) : null,
          h('div', { 'data-ss-panel-foot': '' },
            h('button', {
              type: 'button',
              'data-ss-btn': '',
              'data-ss-block': '',
              disabled: Boolean(busy) || sessionLocked,
              onClick: restoreSession,
            }, t('restoreSession')),
            h('div', { 'data-ss-hint': '' }, t('openSettingsHint'))
          )
        ) : null

        return h('div', { 'data-ss-dock': '' }, chip, panel)
      }

      /* ── 设置 → 技能开关 ── */
      const GlobalSection = () => {
        useLocaleRefresh()
        const [data, setData] = React.useState(null)
        const [loading, setLoading] = React.useState(false)
        const [busy, setBusy] = React.useState('')
        const [error, setError] = React.useState('')
        const [reloadTick, setReloadTick] = React.useState(0)
        const [sourceDraft, setSourceDraft] = React.useState('')
        const [formName, setFormName] = React.useState('')
        const [formDescription, setFormDescription] = React.useState('')
        const [formContent, setFormContent] = React.useState('')

        React.useEffect(() => {
          let alive = true
          setLoading(true)
          setError('')
          fetchState({})
            .then((payload) => {
              if (alive) setData(normalize(payload))
            })
            .catch((failure) => {
              if (alive) setError(errorTextOf(failure))
            })
            .finally(() => {
              if (alive) setLoading(false)
            })
          return () => {
            alive = false
          }
        }, [reloadTick])

        const run = async (label, command, onDone) => {
          if (busy) return
          setBusy(label)
          setError('')
          try {
            const payload = expectOk(await command())
            setData(normalize(payload))
            if (typeof onDone === 'function') onDone()
          } catch (failure) {
            setError(errorTextOf(failure))
          } finally {
            setBusy('')
          }
        }

        const toggleGlobal = (skill, nextOn) => run('skill:' + String(skill && skill.name), () => jpost('/toggle', {
          name: skill && skill.name,
          scope: 'global',
          disabled: !nextOn,
        }))

        const resetAll = () => {
          if (!confirmAction(t('confirmResetAll'))) return
          run('reset-all', () => jpost('/reset-sessions', {}))
        }

        const addSource = () => {
          const path = String(sourceDraft || '').trim()
          if (!path) return
          run('source:add', () => jpost('/source', { action: 'add', path: path }), () => setSourceDraft(''))
        }

        const removeSource = (path) => run('source:' + String(path), () => jpost('/source', {
          action: 'remove',
          path: path,
        }))

        const createManaged = () => {
          const name = String(formName || '').trim()
          const description = String(formDescription || '').trim()
          if (!name || !description) return
          run('managed:add', () => jpost('/managed', {
            action: 'add',
            name: name,
            description: description,
            content: String(formContent || ''),
          }), () => {
            setFormName('')
            setFormDescription('')
            setFormContent('')
          })
        }

        const removeManaged = (name) => {
          if (!confirmAction(t('confirmDeleteSkill'))) return
          run('managed:' + String(name), () => jpost('/managed', {
            action: 'remove',
            name: name,
          }))
        }

        const skills = data && Array.isArray(data.skills) ? data.skills.slice() : []
        skills.sort((left, right) => String(left && left.name).localeCompare(String(right && right.name)))
        const globalDisabled = data && Array.isArray(data.globalDisabled) ? data.globalDisabled : []
        const disabledSet = {}
        for (const name of globalDisabled) {
          if (typeof name === 'string') disabledSet[name] = true
        }
        const overrides = data && typeof data.sessionsWithOverrides === 'number' ? data.sessionsWithOverrides : 0
        const sources = data && Array.isArray(data.sources) ? data.sources : []
        const managed = data && Array.isArray(data.managed) ? data.managed : []
        const firstLoad = loading && !data

        const skillRows = skills.map((skill) => {
          const name = String((skill && skill.name) || '')
          const on = !disabledSet[name]
          const badge = badgeOf(skill && skill.reason)
          const source = String((skill && skill.source) || 'unknown')
          return h('div', {
            'data-ss-row': '',
            key: 'global-skill:' + name,
            title: skill && skill.description ? String(skill.description) : undefined,
          },
            h('div', { 'data-ss-grow': '' },
              h('div', { 'data-ss-name': '' },
                h('span', { 'data-ss-name-text': '' }, name),
                h('span', { 'data-ss-badge': '', 'data-tone': badge.tone }, t(badge.key)),
                skill && skill.missing
                  ? h('span', { 'data-ss-badge': '', 'data-tone': 'warn' }, t('missingSkill'))
                  : null,
                h('span', { 'data-ss-badge': '', 'data-tone': 'none' }, source)
              ),
              skill && skill.description
                ? h('div', { 'data-ss-note': '' }, String(skill.description))
                : null,
              noteOf(name) ? h('div', { 'data-ss-zh': '' }, noteOf(name)) : null
            ),
            h(Switch, {
              on: on,
              disabled: Boolean(busy),
              title: on ? t('disabled') : t('enabled'),
              onChange: (next) => toggleGlobal(skill, next),
            })
          )
        })

        const sourceRows = sources.length === 0
          ? [h('div', { 'data-ss-empty': '', key: 'sources-empty' }, t('sourceEmpty'))]
          : sources.map((source, index) => {
            const path = String((source && source.path) || '')
            return h('div', { 'data-ss-row': '', key: 'source:' + index + ':' + path },
              h('span', { 'data-ss-path': '', title: path }, path),
              h('button', {
                type: 'button',
                'data-ss-btn': '',
                'data-ss-danger': '',
                disabled: Boolean(busy),
                onClick: () => removeSource(path),
              }, t('remove'))
            )
          })

        const managedRows = managed.length === 0
          ? [h('div', { 'data-ss-empty': '', key: 'managed-empty' }, t('managedEmpty'))]
          : managed.map((entry, index) => {
            const name = String((entry && entry.name) || '')
            const description = String((entry && entry.description) || '')
            return h('div', { 'data-ss-row': '', key: 'managed:' + index + ':' + name },
              h('div', { 'data-ss-grow': '' },
                h('div', { 'data-ss-name': '' },
                  h('span', { 'data-ss-name-text': '' }, name)
                ),
                h('div', { 'data-ss-note': '', title: String((entry && entry.path) || '') }, description)
              ),
              h('button', {
                type: 'button',
                'data-ss-btn': '',
                'data-ss-danger': '',
                disabled: Boolean(busy),
                onClick: () => removeManaged(name),
              }, t('delete'))
            )
          })

        return h('div', { 'data-ss-page': '' },
          h('div', { 'data-ss-head': '' },
            h('div', { 'data-ss-head-row': '' },
              h('div', { 'data-ss-grow': '' },
                h('h3', { 'data-ss-title': '' }, t('pageTitle')),
                h('p', { 'data-ss-desc': '' }, t('pageDesc'))
              ),
              h('button', {
                type: 'button',
                'data-ss-btn': '',
                disabled: Boolean(busy),
                onClick: () => setReloadTick((value) => value + 1),
              }, t('refresh'))
            )
          ),
          firstLoad ? h('div', { 'data-ss-msg': '' }, t('loading')) : null,
          error ? h('div', { 'data-ss-msg': '', 'data-warn': '' }, t('errorPrefix') + error) : null,
          h('section', { 'data-ss-sec': '' },
            h('h3', { 'data-ss-h': '' }, t('sessionTitle')),
            h('p', { 'data-ss-sub': '' }, t('sessionDesc')),
            h('div', { 'data-ss-row': '' },
              h('span', { 'data-ss-count': '', 'data-ss-grow': '' }, t('sessionsWithOverrides', { count: overrides })),
              h('button', {
                type: 'button',
                'data-ss-btn': '',
                'data-ss-danger': '',
                disabled: Boolean(busy) || overrides === 0,
                onClick: resetAll,
              }, t('resetAllSessions'))
            )
          ),
          h('section', { 'data-ss-sec': '' },
            h('h3', { 'data-ss-h': '' }, t('globalTitle')),
            h('p', { 'data-ss-sub': '' }, t('globalDesc')),
            skillRows.length === 0
              ? h('div', { 'data-ss-empty': '' }, t('noResults'))
              : h('div', null, skillRows)
          ),
          h('section', { 'data-ss-sec': '' },
            h('h3', { 'data-ss-h': '' }, t('sourcesTitle')),
            h('p', { 'data-ss-sub': '' }, t('sourcesDesc')),
            h('div', null, sourceRows),
            h('div', { 'data-ss-inline': '' },
              h('input', {
                'data-ss-input': '',
                type: 'text',
                value: sourceDraft,
                placeholder: t('sourcePlaceholder'),
                onChange: (event) => setSourceDraft(event && event.target ? event.target.value : ''),
              }),
              h('button', {
                type: 'button',
                'data-ss-btn': '',
                'data-ss-primary': '',
                disabled: Boolean(busy) || !String(sourceDraft || '').trim(),
                onClick: addSource,
              }, t('add'))
            )
          ),
          h('section', { 'data-ss-sec': '' },
            h('h3', { 'data-ss-h': '' }, t('managedTitle')),
            h('p', { 'data-ss-sub': '' }, t('managedDesc')),
            h('div', null, managedRows),
            h('div', { 'data-ss-form': '' },
              h('input', {
                'data-ss-input': '',
                type: 'text',
                value: formName,
                placeholder: t('managedNamePlaceholder'),
                onChange: (event) => setFormName(event && event.target ? event.target.value : ''),
              }),
              h('input', {
                'data-ss-input': '',
                type: 'text',
                value: formDescription,
                placeholder: t('managedDescriptionPlaceholder'),
                onChange: (event) => setFormDescription(event && event.target ? event.target.value : ''),
              }),
              h('input', {
                'data-ss-input': '',
                type: 'text',
                value: formContent,
                placeholder: t('managedContentPlaceholder'),
                onChange: (event) => setFormContent(event && event.target ? event.target.value : ''),
              }),
              h('button', {
                type: 'button',
                'data-ss-btn': '',
                'data-ss-primary': '',
                disabled: Boolean(busy) || !String(formName || '').trim() || !String(formDescription || '').trim(),
                onClick: createManaged,
              }, t('create'))
            )
          )
        )
      }

      return {
        Switch: Switch,
        DockChip: DockChip,
        GlobalSection: GlobalSection,
      }
    }

    /* ────────────────────────── 注册 ────────────────────────── */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (!ctx || typeof ctx !== 'object') return

        // 1) 样式：一个 <style>，卸载时由 ctx.effect 清理
        if (typeof document !== 'undefined' && document && document.head && typeof document.createElement === 'function') {
          const style = document.createElement('style')
          try {
            style.setAttribute('data-plugin-css', STYLE_ATTR)
          } catch (error) {
            /* ignore */
          }
          style.textContent = CSS
          document.head.appendChild(style)
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => {
              try {
                if (style && typeof style.remove === 'function') style.remove()
              } catch (error) {
                /* ignore */
              }
            }, STYLE_ATTR + ': style')
          }
        }

        // 2) locale 字典（ctx.locale 可能不存在，全守卫）
        const registerLocale = () => {
          const locale = ctx.locale
          if (!locale || typeof locale.register !== 'function') return () => {}
          const disposers = []
          const add = (lang, dict) => {
            try {
              const off = locale.register(LOCALE_NS, lang, dict)
              if (typeof off === 'function') disposers.push(off)
            } catch (error) {
              /* best-effort */
            }
          }
          add('zh', ZH)
          add('en', EN)
          return () => {
            for (const off of disposers) {
              try {
                off()
              } catch (error) {
                /* ignore */
              }
            }
          }
        }
        if (typeof ctx.effect === 'function') ctx.effect(registerLocale, LOCALE_NS + ': locale')
        else registerLocale()

        // 3) slots
        const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

        const ui = createUI(ctx)

        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'skill-switch',
          order: 60,
          label: () => translate(ctx, 'settingsNav'),
        }, ui.GlobalSection))

        slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'skill-switch',
          order: 40,
          inject: (sessionId) => ({ sessionId: sessionId }),
        }, ui.DockChip))
      },
    }
  },
})
