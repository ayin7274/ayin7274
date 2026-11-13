/**
 * lib/state.js —— 开关状态的持久化与生效规则
 *
 * 契约（SPEC §5）：
 *  - 状态文件：$DSH_HOME/skill-switch/state.json
 *  - 形状：{ version: 1, global: { disabled: { [name]: meta } }, sessions: { [sid]: { enabled, disabled, updatedAt } }, sources: [{ path, addedAt }] }
 *  - 写：mkdir -p + 临时文件 + rename（原子）
 *  - 读：文件不存在 → 空状态；JSON 损坏 → 改名 .bak 后返回空状态（warn）
 *  - effective(state, sessionId, name) → { enabled, reason }
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export const STATE_VERSION = 1

/** 新会话 / 缺失状态文件时的初始值 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    global: { disabled: {} },
    sessions: {},
    sources: [],
  }
}

/**
 * 读取状态。永远返回合法状态对象，不会抛错。
 * @param {string} file
 * @param {{ warn?: Function }} [logger]
 */
export function loadState(file, logger) {
  try {
    if (!file || !existsSync(file)) return emptyState()
    const text = readFileSync(file, 'utf8')
    if (!text.trim()) return emptyState()

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`invalid JSON: ${errorText(error)}`)
    }
    if (!isPlainObject(parsed)) throw new Error('state root is not an object')
    return normalizeState(parsed)
  } catch (error) {
    backupBrokenState(file)
    logger?.warn?.(
      `skill-switch: state file ${file} is broken, backed up and reset: ${errorText(error)}`,
    )
    return emptyState()
  }
}

/**
 * 原子写入状态：先写同目录临时文件，再 rename 覆盖。
 * @param {string} file
 * @param {object} state
 */
export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const json = `${JSON.stringify(state, null, 2)}\n`
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, json, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows 上极少数情况 rename 覆盖会失败：清掉旧文件再 rename
    try {
      rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
    renameSync(tmp, file)
  }
  return state
}

/**
 * 生效规则（SPEC §5.3）：session.enabled > session.disabled > global.disabled > default
 * @param {object} state
 * @param {string | null | undefined} sessionId
 * @param {string} name
 * @returns {{ enabled: boolean, reason: 'default' | 'global' | 'session-enabled' | 'session-disabled' }}
 */
export function effective(state, sessionId, name) {
  const session = sessionId ? state?.sessions?.[sessionId] : undefined
  if (session) {
    if (hasKey(session.enabled, name)) return { enabled: true, reason: 'session-enabled' }
    if (hasKey(session.disabled, name)) return { enabled: false, reason: 'session-disabled' }
  }
  if (hasKey(state?.global?.disabled, name)) return { enabled: false, reason: 'global' }
  return { enabled: true, reason: 'default' }
}

/** 把磁盘上读到的任意形状收拢成合法状态（字段缺失就补默认值） */
function normalizeState(value) {
  const state = emptyState()

  if (isPlainObject(value.global) && isPlainObject(value.global.disabled)) {
    state.global.disabled = copyRecordMap(value.global.disabled)
  }

  if (isPlainObject(value.sessions)) {
    for (const [sessionId, session] of Object.entries(value.sessions)) {
      if (!isPlainObject(session)) continue
      /** @type {{ enabled: Record<string, object>, disabled: Record<string, object>, updatedAt?: string }} */
      const next = { enabled: {}, disabled: {} }
      if (isPlainObject(session.enabled)) next.enabled = copyRecordMap(session.enabled)
      if (isPlainObject(session.disabled)) next.disabled = copyRecordMap(session.disabled)
      if (typeof session.updatedAt === 'string') next.updatedAt = session.updatedAt
      state.sessions[sessionId] = next
    }
  }

  if (Array.isArray(value.sources)) {
    for (const source of value.sources) {
      if (!isPlainObject(source) || typeof source.path !== 'string' || !source.path) continue
      /** @type {{ path: string, addedAt?: string }} */
      const next = { path: source.path }
      if (typeof source.addedAt === 'string') next.addedAt = source.addedAt
      state.sources.push(next)
    }
  }

  return state
}

/** 只保留 plain object 的条目（容忍手改坏的文件） */
function copyRecordMap(map) {
  const out = {}
  for (const [key, value] of Object.entries(map)) {
    if (isPlainObject(value)) out[key] = { ...value }
  }
  return out
}

function backupBrokenState(file) {
  if (!file || !existsSync(file)) return
  try {
    const bak = `${file}.bak`
    try {
      rmSync(bak, { force: true })
    } catch {
      /* ignore */
    }
    renameSync(file, bak)
  } catch {
    /* 备份失败也不该让调用方炸掉 */
  }
}

function hasKey(map, key) {
  return isPlainObject(map) && Object.hasOwn(map, key)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
