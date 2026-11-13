#!/usr/bin/env node
/**
 * dsh-skill-switch —— 浏览器半端自检（SPEC §9 / §10 / §11）
 * ============================================================================
 * 纯静态 + 假运行时，不启动浏览器、不碰网络、不写任何文件：
 *   1. package.json 与 client 注册 id 一致
 *   2. locale/zh.json、locale/en.json 可解析、键集一致、44 个必需键齐全
 *   3. client.js 内联的 ZH/EN 字典与 locale/*.json 逐字一致
 *   4. client.js 是自注册 classic script（无 import/export，只 require('react')）
 *   5. 假 window/document/React/ctx 下 apply 不抛错，注册两个 slot、注入一个 <style>、
 *      注册 zh/en 两套 locale
 *   6. 组件可渲染（settings 页 + dock 胶囊），apply 与渲染都不发网络请求
 *
 * 用法：node scripts/selfcheck-client.mjs   成功时打印 PASS client
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))

const failures = []
const check = (ok, label, detail) => {
  if (ok) {
    console.log('  ok   ' + label)
    return true
  }
  const message = detail === undefined || detail === null ? '' : ' → ' + String(detail)
  failures.push(label + message)
  console.log('  FAIL ' + label + message)
  return false
}
const eq = (actual, expected, label) => check(
  JSON.stringify(actual) === JSON.stringify(expected),
  label,
  'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual),
)

const REQUIRED_KEYS = [
  'settingsNav', 'pageTitle', 'pageDesc', 'refresh', 'resetAllSessions', 'sessionsWithOverrides',
  'globalTitle', 'globalDesc', 'sessionTitle', 'sessionDesc', 'sessionChip', 'sessionPanelTitle',
  'sessionPanelHint', 'restoreSession', 'searchPlaceholder', 'noResults', 'badgeDefault',
  'badgeGlobal', 'badgeSession', 'badgeSessionEnabled', 'enabled', 'disabled', 'sourcesTitle',
  'sourcesDesc', 'sourcePlaceholder', 'add', 'remove', 'sourceEmpty', 'managedTitle', 'managedDesc',
  'managedNamePlaceholder', 'managedDescriptionPlaceholder', 'managedContentPlaceholder', 'create',
  'delete', 'managedEmpty', 'missingSkill', 'loading', 'errorPrefix', 'sessionCwd',
  'openSettingsHint', 'confirmResetAll', 'confirmDeleteSkill',
]

const sortedKeys = (dict) => Object.keys(dict).sort()
const canonical = (dict) => JSON.stringify(sortedKeys(dict).map((key) => [key, dict[key]]))

const readJson = (rel, label) => {
  const raw = readFileSync(here(rel), 'utf8')
  try {
    const parsed = JSON.parse(raw)
    check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), label + ' parses to an object')
    return parsed
  } catch (error) {
    check(false, label + ' parses as JSON', error && error.message)
    return {}
  }
}

const extractInlineDicts = (source) => {
  const pluck = (name) => {
    const startMarker = '/* locale:' + name + ':start */'
    const endMarker = '/* locale:' + name + ':end */'
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker)
    if (start === -1 || end === -1 || end <= start) return undefined
    const chunk = source.slice(start + startMarker.length, end)
    const braceStart = chunk.indexOf('{')
    const braceEnd = chunk.lastIndexOf('}')
    if (braceStart === -1 || braceEnd <= braceStart) return undefined
    try {
      return JSON.parse(chunk.slice(braceStart, braceEnd + 1))
    } catch (error) {
      return undefined
    }
  }
  return { zh: pluck('zh'), en: pluck('en') }
}

/* ─────────────────────────── 1. 包名与产物路径 ─────────────────────────── */

console.log('dsh-skill-switch client selfcheck')

const pkg = readJson('../package.json', 'package.json')
const clientSource = readFileSync(here('../client.js'), 'utf8')
const zhJson = readJson('../locale/zh.json', 'locale/zh.json')
const enJson = readJson('../locale/en.json', 'locale/en.json')

check(typeof pkg.name === 'string' && pkg.name === 'dsh-skill-switch', 'package name is dsh-skill-switch', pkg.name)
check(
  clientSource.includes("id: 'dsh-skill-switch'") || clientSource.includes('id: "dsh-skill-switch"'),
  'client.js registers id dsh-skill-switch'
)
check(clientSource.includes('window.__ModuleLoader__.load('), 'client.js self-registers via window.__ModuleLoader__')

/* ─────────────────────────── 2. locale 文件 ─────────────────────────── */

const zhKeys = sortedKeys(zhJson)
const enKeys = sortedKeys(enJson)
eq(zhKeys, enKeys, 'zh/en locale files share the same key set')
for (const key of REQUIRED_KEYS) {
  check(Object.prototype.hasOwnProperty.call(zhJson, key), 'zh.json has key ' + key)
  check(Object.prototype.hasOwnProperty.call(enJson, key), 'en.json has key ' + key)
}
for (const [lang, dict] of [['zh', zhJson], ['en', enJson]]) {
  const empty = sortedKeys(dict).filter((key) => typeof dict[key] !== 'string' || dict[key].trim() === '')
  eq(empty, [], lang + '.json values are non-empty strings')
}
const zhVars = sortedKeys(zhJson).filter((key) => /\{\w+\}/.test(zhJson[key])).sort()
const enVars = sortedKeys(enJson).filter((key) => /\{\w+\}/.test(enJson[key])).sort()
eq(zhVars, enVars, 'zh/en locale files use the same placeholders')

/* ─────────────────────────── 3. 内联字典一致性 ─────────────────────────── */

const inline = extractInlineDicts(clientSource)
check(Boolean(inline.zh), 'client.js contains an inline zh dictionary between markers')
check(Boolean(inline.en), 'client.js contains an inline en dictionary between markers')
eq(inline.zh, zhJson, 'inline zh dictionary === locale/zh.json')
eq(inline.en, enJson, 'inline en dictionary === locale/en.json')
eq(sortedKeys(inline.zh || {}), sortedKeys(zhJson), 'inline zh key set matches locale file')

/* ─────────────────────────── 4. classic script 形态 ─────────────────────────── */

const codeLines = clientSource.split(/\r?\n/)
const esmAtTopLevel = codeLines.filter((line) => /^\s*(?:import|export)\b/.test(line))
eq(esmAtTopLevel, [], 'client.js has no top-level import/export statement')

const requires = Array.from(clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map((match) => match[1])
const foreignRequires = Array.from(new Set(requires.filter((name) => name !== 'react')))
eq(foreignRequires, [], "client.js only requires 'react'")

check(/dsw-alias-/.test(clientSource), 'client.js style uses --dsw-alias-* tokens')

/* ─────────────────────────── 5. 假运行时 ─────────────────────────── */

let fetchCalls = 0
globalThis.fetch = () => {
  fetchCalls += 1
  return Promise.reject(new Error('selfcheck: client must not fetch during apply/mount'))
}

const styles = []
const documentStub = {
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      textContent: '',
      attributes: {},
      removed: false,
      setAttribute(name, value) {
        this.attributes[name] = String(value)
      },
      remove() {
        this.removed = true
      },
    }
  },
  head: {
    appendChild(node) {
      styles.push(node)
      return node
    },
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = documentStub

const makeElement = (type, props, children) => ({
  type,
  props: props || {},
  children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
})

const hookState = []
const ReactStub = {
  createElement: (type, props, ...children) => makeElement(type, props, children),
  Fragment: 'Fragment',
  useState(initial) {
    const index = hookState.length
    hookState.push(typeof initial === 'function' ? initial() : initial)
    return [
      hookState[index],
      (next) => {
        hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
      },
    ]
  },
  useEffect() {},
  useMemo(factory) {
    return factory()
  },
  useRef(value) {
    return { current: value }
  },
  useCallback(fn) {
    return fn
  },
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
  confirm: () => true,
}

await import('../client.js')

check(Boolean(captured), 'window.__ModuleLoader__.load received a spec')
check(captured && captured.id === pkg.name, 'registered id matches package name', captured && captured.id)
check(captured && typeof captured.factory === 'function', 'factory is a function')

const registered = []
const disposers = []
let localeRegistrations = []
const makeCtx = (options) => {
  const opts = options || {}
  const ctx = {
    slots: {
      inject(name, factory) {
        const returned = factory()
        if (returned && typeof returned.then === 'function') throw new Error('slots.inject factory must be sync')
      },
      register(slotOptions, Component) {
        registered.push({ ...slotOptions, Component })
        return () => {}
      },
    },
    effect(factory, label) {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push({ label, disposer })
      return () => {}
    },
    get() {
      return undefined
    },
    locale: {
      register(namespace, lang, dict) {
        localeRegistrations.push({ namespace, lang, dict })
        return () => {}
      },
      getSnapshot() {
        return { active: opts.locale || 'zh' }
      },
    },
  }
  if (opts.noLocale) delete ctx.locale
  if (opts.noSlots) delete ctx.slots
  return ctx
}

const ctx = makeCtx({ locale: 'zh' })
let applyError = null
try {
  const plugin = captured.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error('unexpected require: ' + String(name))
  })
  check(Array.isArray(plugin.inject), 'plugin exposes inject array')
  eq(plugin.inject, ['slots', 'locale'], 'plugin injects [slots, locale]')
  check(typeof plugin.apply === 'function', 'plugin exposes apply()')
  plugin.apply(ctx)
} catch (error) {
  applyError = error
}
check(applyError === null, 'apply() does not throw', applyError && applyError.stack)

/* ─────────────────────────── 6. 注册结果断言 ─────────────────────────── */

check(styles.length >= 1, 'apply appends at least one <style> to document.head')
check(styles.every((node) => node.tagName === 'STYLE'), 'appended nodes are <style> elements')
const styleNode = styles[0]
if (styleNode) {
  check(typeof styleNode.textContent === 'string' && styleNode.textContent.length > 200, 'style has real CSS text')
  check(styleNode.textContent.includes('[data-ss-page]'), 'style contains settings page rules')
  check(styleNode.textContent.includes('[data-ss-panel]'), 'style contains dock panel rules')
  check(styleNode.textContent.includes('dsw-alias-'), 'style uses dsw tokens')
}

const byName = (name) => registered.filter((entry) => entry.name === name)
const settingsSlots = byName('settings.section')
const dockSlots = byName('conversation.composer.dock')
check(registered.length === 2, 'exactly two slots registered', registered.length)
check(settingsSlots.length === 1, 'one settings.section registration')
check(dockSlots.length === 1, 'one conversation.composer.dock registration')
check(settingsSlots.every((entry) => String(entry.id).includes('skill-switch')), 'settings.section id contains skill-switch')
check(dockSlots.every((entry) => String(entry.id).includes('skill-switch')), 'composer.dock id contains skill-switch')
eq(settingsSlots.map((entry) => entry.order), [60], 'settings.section order is 60')
eq(dockSlots.map((entry) => entry.order), [40], 'composer.dock order is 40')
check(settingsSlots.every((entry) => typeof entry.Component === 'function'), 'settings.section component is a function')
check(dockSlots.every((entry) => typeof entry.Component === 'function'), 'composer.dock component is a function')
check(settingsSlots.every((entry) => typeof entry.label === 'function'), 'settings.section label is a function')
check(dockSlots.every((entry) => typeof entry.inject === 'function'), 'composer.dock inject is a function')

if (settingsSlots.length === 1 && typeof settingsSlots[0].label === 'function') {
  eq(settingsSlots[0].label(), zhJson.settingsNav, 'settings label resolves zh settingsNav')
}
if (dockSlots.length === 1 && typeof dockSlots[0].inject === 'function') {
  eq(dockSlots[0].inject('sess_abc'), { sessionId: 'sess_abc' }, 'composer.dock inject passes sessionId')
}

const localeLangs = localeRegistrations.map((entry) => entry.lang).sort()
eq(localeLangs, ['en', 'zh'], 'registers zh and en locale dictionaries')
check(localeRegistrations.every((entry) => entry.namespace === 'skillSwitch'), 'locale namespace is skillSwitch')
const zhReg = localeRegistrations.find((entry) => entry.lang === 'zh')
const enReg = localeRegistrations.find((entry) => entry.lang === 'en')
if (zhReg) check(canonical(zhReg.dict) === canonical(zhJson), 'registered zh dict matches locale/zh.json')
if (enReg) check(canonical(enReg.dict) === canonical(enJson), 'registered en dict matches locale/en.json')

check(disposers.length >= 1, 'apply registers at least one ctx.effect disposer')
let disposeError = null
for (const entry of disposers) {
  try {
    entry.disposer()
  } catch (error) {
    disposeError = error
  }
}
check(disposeError === null, 'all disposers run without throwing', disposeError && disposeError.message)
check(
  disposers.some((entry) => entry.label && String(entry.label).includes('style')),
  'style cleanup is registered through ctx.effect'
)

/* ─────────────────────────── 7. 组件渲染冒烟 ─────────────────────────── */

const renderTree = (Component, props, label) => {
  hookState.length = 0
  let tree = null
  let error = null
  try {
    tree = Component(props || {})
  } catch (failure) {
    error = failure
  }
  check(error === null, label + ' renders without throwing', error && error.stack)
  check(Boolean(tree) && typeof tree === 'object', label + ' returns an element tree')
  return tree
}

const settingsTree = renderTree(settingsSlots[0] && settingsSlots[0].Component, {}, 'settings page')
const dockTree = renderTree(dockSlots[0] && dockSlots[0].Component, { sessionId: 'sess_abc' }, 'dock chip')
if (settingsTree && settingsTree.props) check(Boolean(settingsTree.props['data-ss-page']) || settingsTree.props['data-ss-page'] === '', 'settings tree root is the skill switch page')
check(Boolean(dockTree) && Boolean(dockTree.type), 'dock chip tree has a root element')

// 找一个按钮/输入框，确认基本交互元素存在（createElement 只记录，不执行子组件）
const collect = (node, out) => {
  if (!node || typeof node !== 'object') return out
  out.push(node.type)
  const children = node.children
  if (Array.isArray(children)) for (const child of children) collect(child, out)
  else if (children && typeof children === 'object') collect(children, out)
  return out
}
const settingsTypes = collect(settingsTree, [])
const dockTypes = collect(dockTree, [])
check(settingsTypes.includes('button') || settingsTypes.includes('input'), 'settings page renders form controls')
check(dockTypes.includes('button'), 'dock chip renders a button')

/* ─────────────────────────── 8. 降级路径 ─────────────────────────── */

const applyQuietly = (label, nextCtx) => {
  let error = null
  try {
    captured.factory((name) => (name === 'react' ? ReactStub : null)).apply(nextCtx)
  } catch (failure) {
    error = failure
  }
  check(error === null, label, error && error.message)
}

registered.length = 0
applyQuietly('apply() tolerates a missing locale', makeCtx({ noLocale: true }))
applyQuietly('apply() tolerates missing slots', makeCtx({ noSlots: true }))
applyQuietly('apply() tolerates a missing context', undefined)

eq(fetchCalls, 0, 'apply/render never fetch before a real mount')
console.log('  ok   no network before mount (0 fetch calls)')

/* ─────────────────────────── 结论 ─────────────────────────── */

if (failures.length > 0) {
  console.error('')
  console.error(failures.length + ' check(s) failed:')
  for (const failure of failures) console.error('  · ' + failure)
  console.error('FAIL client')
  process.exit(1)
}

console.log('')
console.log('PASS client')
