/**
 * lib/skill-switch.js —— 核心服务：provider / 状态 / payload / 写操作
 *
 * 契约（SPEC §6、§7）：
 *  - provider：rank 0 影子候选（被生效关闭的技能），rank 1 真实候选（会话开启覆盖 / 额外来源 / 托管技能）
 *  - list/toggle/resetSession/resetSessions/addSource/removeSource/addManaged/removeManaged → §7 payload
 *  - 任何写操作成功后：saveState + invalidate()
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseFrontmatter, serializeSkill } from './frontmatter.js'
import { discoverSkills, isSkillName } from './scan.js'
import { effective, loadState, saveState } from './state.js'

export const PROVIDER_NAME = 'skill-switch'

const DISABLED_CONTENT =
  'This skill is disabled for the current session. Enable it in Settings → Skill Switch or via the session skill panel.'

/**
 * @param {{ ctx?: any, dshHome?: string, logger?: { warn?: Function } }} options
 */
export function createSkillSwitch(options = {}) {
  const ctx = options.ctx
  const logger = options.logger ?? ctx?.logger
  const dshHome =
    typeof options.dshHome === 'string' && options.dshHome
      ? options.dshHome
      : process.env.DSH_HOME || join(homedir(), '.dsh')

  const root = join(dshHome, 'skill-switch')
  const paths = {
    root,
    stateFile: join(root, 'state.json'),
    managedDir: join(root, 'skills'),
    skillsDir: join(dshHome, 'skills'),
  }

  let invalidateFn = () => {}

  /** 每次写状态后调用；吞掉异常（宿主可能已经卸载） */
  function invalidate() {
    try {
      invalidateFn()
    } catch (error) {
      logger?.warn?.(`skill-switch: invalidate failed: ${errorText(error)}`)
    }
  }

  function readState() {
    return loadState(paths.stateFile, logger)
  }

  function persist(state) {
    saveState(paths.stateFile, state)
    return state
  }

  /** cwd 缺省取宿主的 defaultDirectory */
  function resolveCwd(cwd) {
    if (typeof cwd === 'string' && cwd.trim()) return cwd.trim()
    try {
      const wd = ctx?.get?.('workingDirectory')
      const fallback = wd?.defaultDirectory
      if (typeof fallback === 'string' && fallback) return fallback
    } catch {
      /* ignore */
    }
    return undefined
  }

  function entriesFor(cwd, state) {
    const sources = (Array.isArray(state.sources) ? state.sources : [])
      .map((item) => (item && typeof item.path === 'string' ? item.path : ''))
      .filter(Boolean)
    return discoverSkills({
      dshHome,
      cwd,
      sources,
      managedDir: paths.managedDir,
      logger,
    })
  }

  /** 当前会话 + 全局的记录：name → 元数据（会话优先，合并去重） */
  function recordNames(state, sessionId) {
    const records = new Map()
    const add = (map) => {
      if (!isPlainObject(map)) return
      for (const [name, record] of Object.entries(map)) {
        if (records.has(name)) continue
        records.set(name, isPlainObject(record) ? record : {})
      }
    }
    const session = sessionId ? state.sessions?.[sessionId] : undefined
    if (isPlainObject(session)) {
      add(session.disabled)
      add(session.enabled)
    }
    add(state.global?.disabled)
    return records
  }

  /** 拉取宿主 registry 的完整快照；失败则当作空（list 绝不能因此失败） */
  async function snapshotSkillsFor(cwd, sessionId) {
    try {
      const skillsService = ctx?.skills
      if (!skillsService || typeof skillsService.snapshot !== 'function') return []
      const lookup = {}
      if (cwd) lookup.cwd = cwd
      let agent
      try {
        agent = sessionId ? ctx?.get?.('agents')?.get?.(sessionId) : undefined
      } catch {
        agent = undefined
      }
      if (agent) lookup.scope = agent
      const snapshot = await skillsService.snapshot(lookup)
      const list = Array.isArray(snapshot) ? snapshot : snapshot?.skills
      return Array.isArray(list) ? list.filter(isPlainObject) : []
    } catch (error) {
      logger?.warn?.(`skill-switch: skills.snapshot failed: ${errorText(error)}`)
      return []
    }
  }

  /**
   * 构造 §7.1 payload。
   * 元数据合并优先级：discoverSkills（磁盘）> skills.snapshot（含 bundled）> state 记录。
   */
  async function buildPayload(input = {}) {
    const sessionId = normalizeSessionId(input.sessionId)
    const state = readState()
    const cwd = resolveCwd(input.cwd)
    const entries = entriesFor(cwd, state)
    const snapshot = await snapshotSkillsFor(cwd, sessionId)
    const records = recordNames(state, sessionId)

    /** @type {Map<string, { name: string, description: string, source: string, path: string | null, present: boolean }>} */
    const merged = new Map()

    for (const entry of entries) {
      merged.set(entry.name, {
        name: entry.name,
        description: entry.description,
        source: entry.source,
        path: entry.path,
        present: true,
      })
    }

    for (const summary of snapshot) {
      const name = summary?.name
      if (typeof name !== 'string' || !name) continue
      const source = normalizeSource(summary.source)
      if (source === 'disabled') continue // 我们自己发出的影子候选，不算磁盘证据
      if (merged.has(name)) continue
      merged.set(name, {
        name,
        description: pickDescription(summary.description, name),
        source,
        path: typeof summary.path === 'string' ? summary.path : null,
        present: true,
      })
    }

    for (const [name, record] of records) {
      if (!merged.has(name)) {
        const path = typeof record?.path === 'string' && record.path ? record.path : null
        merged.set(name, {
          name,
          description: pickDescription(record?.description, name),
          source: normalizeSource(record?.source),
          path,
          // 只存在于 state 记录时，如果记录的 path 还在磁盘上仍算存在
          present: Boolean(path && existsSync(path)),
        })
        continue
      }
      const item = merged.get(name)
      if (!item.path) {
        const path = typeof record?.path === 'string' && record.path ? record.path : null
        if (path) item.path = path
      }
    }

    const skills = [...merged.values()]
      .map((item) => {
        const eff = effective(state, sessionId, item.name)
        return {
          name: item.name,
          description: pickDescription(item.description, item.name),
          source: item.source,
          path: item.path,
          enabled: eff.enabled,
          reason: eff.reason,
          managed: item.source === 'managed',
          missing: !item.present,
        }
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const session = sessionId ? state.sessions?.[sessionId] : undefined
    const sessionsWithOverrides = Object.values(state.sessions ?? {}).filter(
      (item) =>
        isPlainObject(item) &&
        (Object.keys(item.enabled ?? {}).length > 0 ||
          Object.keys(item.disabled ?? {}).length > 0),
    ).length

    return {
      ok: true,
      sessionId,
      cwd: cwd ?? null,
      globalDisabled: Object.keys(state.global?.disabled ?? {}).sort(),
      session: isPlainObject(session)
        ? {
            enabled: Object.keys(session.enabled ?? {}).sort(),
            disabled: Object.keys(session.disabled ?? {}).sort(),
          }
        : null,
      sessionsWithOverrides,
      sources: (Array.isArray(state.sources) ? state.sources : []).map((item) => ({
        path: item.path,
        ...(typeof item.addedAt === 'string' ? { addedAt: item.addedAt } : {}),
      })),
      managed: entries
        .filter((entry) => entry.source === 'managed')
        .map((entry) => ({
          name: entry.name,
          description: entry.description,
          path: entry.path,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      skills,
    }
  }

  /** @type {{ name: string, async list(options?: any): Promise<any[]>, async get(candidate: any, options?: any): Promise<any> }} */
  const provider = {
    name: PROVIDER_NAME,

    async list(providerOptions = {}) {
      const sessionId = normalizeSessionId(providerOptions?.scope?.session?.id)
      const cwd =
        typeof providerOptions?.cwd === 'string' && providerOptions.cwd
          ? providerOptions.cwd
          : undefined
      const state = readState()
      const entries = entriesFor(cwd, state)
      const records = recordNames(state, sessionId)

      const byName = new Map()
      for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry)

      const names = new Set([...byName.keys(), ...records.keys()])
      const candidates = []

      for (const name of names) {
        const entry = byName.get(name)
        const record = records.get(name)
        const eff = effective(state, sessionId, name)

        if (!eff.enabled) {
          // rank 0：影子候选，抢占 filesystem provider 的同名条目，但不可调用
          candidates.push({
            name,
            description: pickDescription(entry?.description, record?.description, name),
            invocation: { modelInvocable: false, userInvocable: false },
            provider: PROVIDER_NAME,
            source: 'disabled',
            rank: 0,
            locator: { kind: 'disabled', name },
          })
          continue
        }

        const sessionEnabled = Boolean(
          sessionId && hasKey(state.sessions?.[sessionId]?.enabled, name),
        )
        const rankOne = entry && (entry.source === 'managed' || entry.source === 'source' || sessionEnabled)
        if (!rankOne) continue // 普通默认开启的技能不由本 provider 发出

        candidates.push({
          name,
          description: entry.description,
          ...(entry.whenToUse ? { whenToUse: entry.whenToUse } : {}),
          invocation: entry.invocation,
          provider: PROVIDER_NAME,
          source: entry.source,
          rank: 1,
          locator: { kind: 'file', path: entry.path },
          resourceBase: { kind: 'directory', path: entry.directory },
        })
      }

      return candidates
    },

    async get(candidate, providerOptions = {}) {
      void providerOptions
      const locator = candidate?.locator
      if (locator?.kind === 'disabled') {
        return {
          name: candidate.name,
          description: pickDescription(candidate?.description, candidate?.name),
          invocation: { modelInvocable: false, userInvocable: false },
          source: 'disabled',
          provider: PROVIDER_NAME,
          content: DISABLED_CONTENT,
        }
      }

      if (locator?.kind === 'file') {
        const filePath = String(locator.path ?? '')
        if (!filePath) throw new Error('skill-switch: candidate locator has no path')
        const raw = readFileSync(filePath, 'utf8')
        const { data, body } = parseFrontmatter(raw)
        const directory =
          candidate?.resourceBase?.kind === 'directory' &&
          typeof candidate.resourceBase.path === 'string'
            ? candidate.resourceBase.path
            : dirname(filePath)
        const description =
          (typeof data.description === 'string' ? data.description.trim() : '') ||
          pickDescription(candidate?.description, candidate?.name)
        const definition = {
          name: String(candidate?.name ?? ''),
          description,
          invocation: {
            modelInvocable: data['disable-model-invocation'] !== true,
            userInvocable: data['user-invocable'] !== false,
          },
          source: typeof candidate?.source === 'string' ? candidate.source : 'source',
          provider: PROVIDER_NAME,
          resourceBase: { kind: 'directory', path: directory },
          path: filePath,
          content: body.trim(),
        }
        const whenToUse =
          typeof data.whenToUse === 'string' && data.whenToUse.trim()
            ? data.whenToUse.trim()
            : undefined
        if (whenToUse) definition.whenToUse = whenToUse
        return definition
      }

      throw new Error(`skill-switch: unsupported locator kind ${String(locator?.kind)}`)
    },
  }

  async function toggle(input = {}) {
    const name = String(input.name ?? '').trim()
    if (!isSkillName(name)) throw badRequest('name must be kebab-case')

    const scope = input.scope === undefined ? 'session' : input.scope
    if (scope !== 'session' && scope !== 'global') {
      throw badRequest("scope must be 'session' or 'global'")
    }
    if (typeof input.disabled !== 'boolean') throw badRequest('disabled must be a boolean')

    const sessionId = normalizeSessionId(input.sessionId)
    if (scope === 'session' && !sessionId) throw badRequest('sessionId is required for session scope')

    const state = readState()
    const cwd = resolveCwd(input.cwd)
    const meta = await lookupMeta(state, name, cwd, sessionId)
    const now = new Date().toISOString()

    if (scope === 'global') {
      if (input.disabled) {
        state.global.disabled[name] = {
          description: meta.description,
          source: meta.source,
          path: meta.path,
          disabledAt: now,
        }
      } else {
        delete state.global.disabled[name]
      }
    } else {
      const session = ensureSession(state, sessionId)
      if (input.disabled) {
        session.disabled[name] = {
          description: meta.description,
          source: meta.source,
          path: meta.path,
          updatedAt: now,
        }
        delete session.enabled[name]
      } else {
        delete session.disabled[name]
        // 全局被关闭时，会话开启需要一条显式覆盖；否则直接删掉
        if (hasKey(state.global?.disabled, name)) {
          session.enabled[name] = { updatedAt: now }
        } else {
          delete session.enabled[name]
        }
      }
      session.updatedAt = now
      pruneSession(state, sessionId)
    }

    persist(state)
    invalidate()
    return buildPayload({ sessionId, cwd })
  }

  async function resetSession(input = {}) {
    const sessionId = normalizeSessionId(input.sessionId)
    if (!sessionId) throw badRequest('sessionId is required')
    const state = readState()
    if (isPlainObject(state.sessions) && hasKey(state.sessions, sessionId)) {
      delete state.sessions[sessionId]
    }
    persist(state)
    invalidate()
    return buildPayload({ sessionId, cwd: input.cwd })
  }

  async function resetSessions(input = {}) {
    const state = readState()
    state.sessions = {}
    persist(state)
    invalidate()
    return buildPayload({ sessionId: input?.sessionId, cwd: input?.cwd })
  }

  async function addSource(pathInput) {
    const raw = typeof pathInput === 'string' ? pathInput.trim() : ''
    if (!raw) throw badRequest('path is required')
    let absolute
    try {
      absolute = resolve(raw)
    } catch {
      throw badRequest('invalid path')
    }
    let stat
    try {
      stat = statSync(absolute)
    } catch {
      throw badRequest(`source directory does not exist: ${absolute}`)
    }
    if (!stat.isDirectory()) throw badRequest(`source path is not a directory: ${absolute}`)

    const state = readState()
    if (!Array.isArray(state.sources)) state.sources = []
    const exists = state.sources.some(
      (item) => item && typeof item.path === 'string' && resolve(item.path) === absolute,
    )
    if (exists) throw badRequest(`source already added: ${absolute}`)

    state.sources.push({ path: absolute, addedAt: new Date().toISOString() })
    persist(state)
    invalidate()
    return buildPayload()
  }

  async function removeSource(pathInput) {
    const raw = typeof pathInput === 'string' ? pathInput.trim() : ''
    if (!raw) throw badRequest('path is required')
    let absolute
    try {
      absolute = resolve(raw)
    } catch {
      throw badRequest('invalid path')
    }
    const state = readState()
    const sources = Array.isArray(state.sources) ? state.sources : []
    const index = sources.findIndex(
      (item) => item && typeof item.path === 'string' && resolve(item.path) === absolute,
    )
    if (index < 0) throw badRequest(`source not found: ${absolute}`)

    sources.splice(index, 1)
    state.sources = sources
    persist(state)
    invalidate()
    return buildPayload()
  }

  async function addManaged(input = {}) {
    const name = String(input.name ?? '').trim()
    if (!isSkillName(name)) throw badRequest('name must be kebab-case')

    const description = String(input.description ?? '').trim()
    if (!description) throw badRequest('description is required')
    if (/[\r\n]/.test(description)) throw badRequest('description must not contain newlines')

    const content = typeof input.content === 'string' ? input.content : ''
    const directory = join(paths.managedDir, name)
    if (existsSync(directory)) throw badRequest(`managed skill already exists: ${name}`)

    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, 'SKILL.md'),
        serializeSkill({ name, description, content }),
        'utf8',
      )
    } catch (error) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      throw new Error(`failed to write managed skill: ${errorText(error)}`)
    }

    persist(readState())
    invalidate()
    return buildPayload()
  }

  async function removeManaged(input = {}) {
    const name = typeof input === 'string' ? input.trim() : String(input?.name ?? '').trim()
    if (!isSkillName(name)) throw badRequest('name must be kebab-case')

    const directory = join(paths.managedDir, name)
    if (!existsSync(directory)) throw badRequest(`managed skill not found: ${name}`)

    try {
      rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      throw new Error(`failed to remove managed skill: ${errorText(error)}`)
    }

    persist(readState())
    invalidate()
    return buildPayload()
  }

  /** 取一次操作的元数据（§7.4）：discovered → snapshot → state 记录 → 兜底 */
  async function lookupMeta(state, name, cwd, sessionId) {
    const entry = entriesFor(cwd, state).find((item) => item.name === name)
    if (entry) {
      return { description: entry.description, source: entry.source, path: entry.path }
    }

    const snapshot = await snapshotSkillsFor(cwd, sessionId)
    const summary = snapshot.find((item) => item?.name === name)
    if (summary) {
      return {
        description: pickDescription(summary.description, name),
        source: normalizeSource(summary.source),
        path: typeof summary.path === 'string' && summary.path ? summary.path : null,
      }
    }

    const record = recordNames(state, sessionId).get(name)
    if (record) {
      return {
        description: pickDescription(record.description, name),
        source: normalizeSource(record.source),
        path: typeof record.path === 'string' && record.path ? record.path : null,
      }
    }

    return { description: name, source: 'unknown', path: null }
  }

  // ---------------------------------------------------------------------------
  // 会话记录的增删（toggle 内部使用）

  function ensureSession(state, sessionId) {
    if (!isPlainObject(state.sessions)) state.sessions = {}
    let session = state.sessions[sessionId]
    if (!isPlainObject(session)) {
      session = { enabled: {}, disabled: {}, updatedAt: new Date().toISOString() }
      state.sessions[sessionId] = session
    }
    if (!isPlainObject(session.enabled)) session.enabled = {}
    if (!isPlainObject(session.disabled)) session.disabled = {}
    return session
  }

  function pruneSession(state, sessionId) {
    const session = state.sessions?.[sessionId]
    if (!isPlainObject(session)) return
    if (
      Object.keys(session.enabled ?? {}).length === 0 &&
      Object.keys(session.disabled ?? {}).length === 0
    ) {
      delete state.sessions[sessionId]
    }
  }

  return {
    paths,
    // SPEC §6：provider() 返回 provider 对象；registry 注册时调用一次即可
    provider: () => provider,
    invalidate,
    setInvalidate(fn) {
      invalidateFn = typeof fn === 'function' ? fn : () => {}
    },
    list: buildPayload,
    toggle,
    resetSession,
    resetSessions,
    addSource,
    removeSource,
    addManaged,
    removeManaged,
    resolveCwd,
  }
}

/** snapshot / 记录里的 source 归一化到 §7.1 词表 */
export function normalizeSource(source) {
  if (typeof source !== 'string' || !source) return 'unknown'
  if (source === 'managed' || source === 'bundled' || source === 'disabled' || source === 'source') {
    return source
  }
  if (source.startsWith('user')) return 'user'
  if (source.startsWith('project')) return 'project'
  if (source === 'custom') return 'source'
  return 'unknown'
}

function pickDescription(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return 'skill'
}

function normalizeSessionId(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

function hasKey(map, key) {
  return isPlainObject(map) && Object.hasOwn(map, key)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function errorText(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
