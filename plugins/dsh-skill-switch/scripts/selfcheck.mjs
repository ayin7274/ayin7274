#!/usr/bin/env node
/**
 * scripts/selfcheck.mjs —— 插件总自检（verifier 所有，SPEC §11）
 *
 * 1) 依次以子进程运行 scripts/selfcheck-host.mjs、scripts/selfcheck-client.mjs，
 *    继承 stdio，任何非零退出即失败。
 * 2) 静态契约检查：package.json / cordis.patch.yml / locale / 模块边界 /
 *    必需标记 / TODO 残留。
 *
 * 只依赖 node: 内置模块；不安装、不启动宿主。
 * 全部通过打印 ALL PASS 并退出 0，否则列出失败并退出 1。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_REL = (target) => relative(PLUGIN_DIR, target) || '.'

const failures = []
let checks = 0

function ok(label) {
  checks += 1
  console.log(`ok   ${label}`)
}

function fail(label, detail) {
  checks += 1
  failures.push({ label, detail })
  console.log(`FAIL ${label}`)
  if (detail) console.log(`     ${String(detail).split('\n').join('\n     ')}`)
}

function check(label, fn) {
  try {
    fn()
    ok(label)
  } catch (error) {
    fail(label, error && error.message ? error.message : error)
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message)
}

function readText(path) {
  return readFileSync(path, 'utf8')
}

function readJson(path) {
  let text
  try {
    text = readText(path)
  } catch (error) {
    throw new Error(`cannot read ${REPO_REL(path)}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${REPO_REL(path)} is not valid JSON: ${error.message}`)
  }
}

/** 收集 host 侧所有 ESM 文件（index.js + lib/*.js） */
function hostFiles() {
  const files = [join(PLUGIN_DIR, 'index.js')]
  const libDir = join(PLUGIN_DIR, 'lib')
  for (const name of readdirSync(libDir).sort()) {
    if (name.endsWith('.js')) files.push(join(libDir, name))
  }
  return files
}

/* ───────────────────────── 子进程自检 ───────────────────────── */

function runChild(script, label) {
  const scriptPath = join(PLUGIN_DIR, 'scripts', script)
  if (!existsSync(scriptPath)) {
    fail(label, `missing ${REPO_REL(scriptPath)}`)
    return
  }
  console.log(`---- ${label}: node scripts/${script} (cwd=plugin) ----`)
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: PLUGIN_DIR,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) {
    fail(label, `spawn failed: ${result.error.message}`)
    return
  }
  if (result.status !== 0) {
    fail(label, `exited with code ${result.status}${result.signal ? ` (signal ${result.signal})` : ''}`)
    return
  }
  ok(`${label} (exit 0)`)
}

runChild('selfcheck-host.mjs', 'selfcheck-host')
runChild('selfcheck-client.mjs', 'selfcheck-client')

/* ───────────────────── 静态检查：文件结构 ───────────────────── */

const REQUIRED_FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'package.json',
  'lib/frontmatter.js',
  'lib/scan.js',
  'lib/state.js',
  'lib/skill-switch.js',
  'lib/http.js',
  'locale/zh.json',
  'locale/en.json',
  'scripts/selfcheck-host.mjs',
  'scripts/selfcheck-client.mjs',
]

check('required files exist', () => {
  const missing = REQUIRED_FILES.filter((name) => !existsSync(join(PLUGIN_DIR, name)))
  must(missing.length === 0, `missing: ${missing.join(', ')}`)
})

/* ───────────────────── 静态检查：package.json ───────────────────── */

const pkg = (() => {
  try {
    return readJson(join(PLUGIN_DIR, 'package.json'))
  } catch (error) {
    fail('package.json parses', error.message)
    return {}
  }
})()

check('package.json parses', () => {
  must(pkg && typeof pkg === 'object', 'package.json must be an object')
})

check('package.json name/version/type/main', () => {
  must(pkg.name === 'dsh-skill-switch', `name must be "dsh-skill-switch", got ${JSON.stringify(pkg.name)}`)
  must(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(pkg.version)), `version must be semver, got ${JSON.stringify(pkg.version)}`)
  must(pkg.type === 'module', `type must be "module", got ${JSON.stringify(pkg.type)}`)
  const main = String(pkg.main ?? '').replace(/^\.\//, '')
  must(main === 'index.js', `main must be index.js, got ${JSON.stringify(pkg.main)}`)
  must(pkg.private === true, 'private must be true (not for npm publish)')
})

check('package.json exports', () => {
  must(pkg.exports && typeof pkg.exports === 'object', 'exports object is required')
  must(pkg.exports['.'] === './index.js', `exports["."] must be "./index.js", got ${JSON.stringify(pkg.exports['.'])}`)
  must(pkg.exports['./client'] === './client.js', `exports["./client"] must be "./client.js", got ${JSON.stringify(pkg.exports['./client'])}`)
  must(typeof pkg.exports['./locale/*.json'] === 'string', 'exports["./locale/*.json"] is required')
})

check('package.json dsh.bundle.patch / dsh.client', () => {
  must(pkg.dsh && typeof pkg.dsh === 'object', 'dsh section is required')
  must(pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', `dsh.bundle.patch must be "./cordis.patch.yml", got ${JSON.stringify(pkg.dsh.bundle && pkg.dsh.bundle.patch)}`)
  must(pkg.dsh.client && typeof pkg.dsh.client === 'object', 'dsh.client section is required')
  must(pkg.dsh.client.platform === 'web', `dsh.client.platform must be "web", got ${JSON.stringify(pkg.dsh.client.platform)}`)
  must(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0, 'dsh.client.inject must be a non-empty array')
  for (const entry of pkg.dsh.client.inject) {
    must(typeof entry === 'string' && entry.startsWith('@deepseek-ai/'), `dsh.client.inject entries must be @deepseek-ai/* package ids, got ${JSON.stringify(entry)}`)
  }
  must(existsSync(join(PLUGIN_DIR, 'cordis.patch.yml')), 'dsh.bundle.patch target cordis.patch.yml is missing')
})

check('package.json has no runtime npm dependencies', () => {
  const deps = Object.keys(pkg.dependencies ?? {})
  const peers = Object.keys(pkg.peerDependencies ?? {})
  must(deps.length === 0, `runtime dependencies must be empty, got: ${deps.join(', ')}`)
  must(peers.length === 0, `peerDependencies must be empty, got: ${peers.join(', ')}`)
  const engines = pkg.engines ?? {}
  must(String(engines.node ?? '').includes('22'), `engines.node must require >=22, got ${JSON.stringify(engines.node)}`)
})

/* ───────────────────── 静态检查：cordis.patch.yml ───────────────────── */

check('cordis.patch.yml declares id skill-switch / name dsh-skill-switch', () => {
  const text = readText(join(PLUGIN_DIR, 'cordis.patch.yml'))
  const lines = text.split(/\r?\n/)
  const idLine = lines.findIndex((line) => /^\s*-\s*id:\s*skill-switch\s*$/.test(line))
  must(idLine >= 0, 'no line matching "- id: skill-switch"')
  const near = lines.slice(idLine, idLine + 4).join('\n')
  must(/^\s*name:\s*dsh-skill-switch\s*$/m.test(near), 'no "name: dsh-skill-switch" following the id line')
  must(/- insert:/.test(text), 'patch must use an "insert" operation')
})

/* ───────────────────── 静态检查：locale ───────────────────── */

const LOCALE_REQUIRED_KEYS = [
  'settingsNav', 'pageTitle', 'pageDesc', 'refresh', 'resetAllSessions', 'sessionsWithOverrides',
  'globalTitle', 'globalDesc', 'sessionTitle', 'sessionDesc', 'sessionChip', 'sessionPanelTitle',
  'sessionPanelHint', 'restoreSession', 'searchPlaceholder', 'noResults', 'badgeDefault',
  'badgeGlobal', 'badgeSession', 'badgeSessionEnabled', 'enabled', 'disabled', 'sourcesTitle',
  'sourcesDesc', 'sourcePlaceholder', 'add', 'remove', 'sourceEmpty', 'managedTitle',
  'managedDesc', 'managedNamePlaceholder', 'managedDescriptionPlaceholder',
  'managedContentPlaceholder', 'create', 'delete', 'managedEmpty', 'missingSkill', 'loading',
  'errorPrefix', 'sessionCwd', 'openSettingsHint', 'confirmResetAll', 'confirmDeleteSkill',
]

const locales = {}
check('locale zh/en parse with identical key sets', () => {
  for (const lang of ['zh', 'en']) {
    locales[lang] = readJson(join(PLUGIN_DIR, 'locale', `${lang}.json`))
    must(locales[lang] && typeof locales[lang] === 'object' && !Array.isArray(locales[lang]), `${lang}.json must be an object`)
  }
  const zhKeys = Object.keys(locales.zh).sort()
  const enKeys = Object.keys(locales.en).sort()
  must(zhKeys.length > 0, 'zh.json has no keys')
  must(JSON.stringify(zhKeys) === JSON.stringify(enKeys), `zh/en key sets differ: only-zh=[${zhKeys.filter((k) => !enKeys.includes(k))}] only-en=[${enKeys.filter((k) => !zhKeys.includes(k))}]`)
  const missing = LOCALE_REQUIRED_KEYS.filter((key) => !zhKeys.includes(key))
  must(missing.length === 0, `locale is missing SPEC §10 keys: ${missing.join(', ')}`)
  for (const lang of ['zh', 'en']) {
    for (const key of Object.keys(locales[lang])) {
      const value = locales[lang][key]
      must(typeof value === 'string' && value.trim().length > 0, `${lang}.json["${key}"] must be a non-empty string`)
    }
  }
})

check('locale zh/en have matching placeholders', () => {
  const placeholders = (value) => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort()
  for (const key of Object.keys(locales.zh ?? {})) {
    const zh = placeholders(locales.zh[key])
    const en = placeholders(locales.en?.[key])
    must(JSON.stringify(zh) === JSON.stringify(en), `placeholder mismatch for "${key}": zh=${JSON.stringify(zh)} en=${JSON.stringify(en)}`)
  }
})

/* ───────────────────── 静态检查：模块边界 ───────────────────── */

function importSpecifiers(text) {
  const specifiers = []
  const staticRe = /(?:^|\n)[ \t]*(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g
  for (const match of text.matchAll(staticRe)) specifiers.push(match[1])
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of text.matchAll(dynamicRe)) specifiers.push(match[1])
  return specifiers
}

check('host modules import only node: builtins (plus local files)', () => {
  for (const file of hostFiles()) {
    const rel = REPO_REL(file)
    const text = readText(file)
    for (const specifier of importSpecifiers(text)) {
      const isLocal = specifier.startsWith('./') || specifier.startsWith('../')
      const isNode = specifier.startsWith('node:')
      must(isLocal || isNode, `${rel} imports non-node specifier "${specifier}"`)
      must(!specifier.startsWith('@deepseek-ai/'), `${rel} must not import "${specifier}"`)
    }
    must(!/\brequire\s*\(/.test(text), `${rel} must not use require() (pure ESM)`)
  }
})

check('client.js: no top-level import/export, only require("react")', () => {
  const path = join(PLUGIN_DIR, 'client.js')
  const text = readText(path)
  const topLevel = /(^|\n)[ \t]*(?:import|export)\s/.exec(text)
  must(topLevel === null, `client.js has a top-level import/export statement near: ${topLevel ? topLevel[0].trim().slice(0, 60) : ''}`)
  const requires = [...text.matchAll(/\brequire\s*\(\s*(['"])([^'"]*)\1\s*\)/g)].map((match) => match[2])
  must(requires.length > 0, 'client.js never calls require()')
  for (const specifier of requires) {
    must(specifier === 'react', `client.js requires "${specifier}" but only "react" is allowed`)
  }
  must(/__ModuleLoader__\.load\s*\(/.test(text), 'client.js must self-register through window.__ModuleLoader__.load')
  must(/id:\s*['"]dsh-skill-switch['"]/.test(text), 'client.js registration id must be "dsh-skill-switch"')
})

/* ───────────────────── 静态检查：必需标记 ───────────────────── */

function requireMarkers(relPath, markers) {
  const text = readText(join(PLUGIN_DIR, relPath))
  for (const marker of markers) {
    must(text.includes(marker), `${relPath} is missing marker ${JSON.stringify(marker)}`)
  }
}

check('host markers: registerProvider / skill_switch / /api/skill-switch', () => {
  requireMarkers('index.js', ['registerProvider', 'skill_switch', '/api/skill-switch'])
  requireMarkers('lib/http.js', ["'/api/skill-switch'", 'MAX_BODY_BYTES'])
})

check('provider rank constants: rank 0 shadow / rank 1 real / provider name', () => {
  const text = readText(join(PLUGIN_DIR, 'lib', 'skill-switch.js'))
  must(text.includes('rank: 0'), 'lib/skill-switch.js is missing "rank: 0" shadow candidate')
  must(text.includes('rank: 1'), 'lib/skill-switch.js is missing "rank: 1" real candidate')
  must(/PROVIDER_NAME\s*=\s*'skill-switch'/.test(text), "lib/skill-switch.js must define PROVIDER_NAME = 'skill-switch'")
  must(text.includes('modelInvocable: false'), 'lib/skill-switch.js shadow candidate must set modelInvocable:false')
})

check('client markers: settings.section + conversation.composer.dock + locale namespace', () => {
  requireMarkers('client.js', [
    "'settings.section'",
    "'conversation.composer.dock'",
    'skillSwitch',
    '/api/skill-switch',
    'if (!res.ok) throw',
  ])
})

/* ───────────────────── 静态检查：TODO 残留 ───────────────────── */

const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/
check('no leftover TODO/FIXME/XXX/HACK markers', () => {
  const targets = [
    ...hostFiles(),
    join(PLUGIN_DIR, 'client.js'),
    join(PLUGIN_DIR, 'scripts', 'selfcheck-host.mjs'),
    join(PLUGIN_DIR, 'scripts', 'selfcheck-client.mjs'),
  ]
  const hits = []
  for (const file of targets) {
    const rel = REPO_REL(file)
    readText(file)
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (TODO_PATTERN.test(line)) hits.push(`${rel}:${index + 1}`)
      })
  }
  must(hits.length === 0, `leftover markers at: ${hits.join(', ')}`)
})

/* ───────────────────────── 汇总 ───────────────────────── */

console.log('')
if (failures.length > 0) {
  console.log(`SELFCHECK FAILED: ${failures.length} failure(s) across ${checks} checks`)
  for (const item of failures) console.log(`  - ${item.label}`)
  process.exit(1)
}
console.log(`ALL PASS (${checks} checks)`)
process.exit(0)
