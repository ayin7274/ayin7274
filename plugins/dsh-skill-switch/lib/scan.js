/**
 * lib/scan.js —— 扫描技能目录，构建宿主侧 `SkillEntry`
 *
 * 契约（SPEC §4）：
 *   discoverSkills({ dshHome, cwd, sources = [], managedDir }) → SkillEntry[]
 *
 * 只扫描「一层」：每个 root 下 `<dir>/SKILL.md` 或 `<file>.md`。
 * root 顺序：managed → sources → cwd/.dsh/skills → cwd/.agents/skills → dshHome/skills。
 * root 缺失、文件读不了、frontmatter 坏了都只是跳过 —— 绝不让 apply/list 抛错。
 *
 * SkillEntry = {
 *   name, description, whenToUse?, invocation: { modelInvocable, userInvocable },
 *   path, directory, source, root,
 * }
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from './frontmatter.js'

/** 合法的 skill name（与 registry 的校验规则一致） */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** @param {unknown} name */
export function isSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_PATTERN.test(name)
}

/** 被 @deepseek-ai/dsh-skill-filesystem 拒绝的旧键；出现即视为解析失败 */
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']

/**
 * @param {{ dshHome?: string, cwd?: string, sources?: unknown[], managedDir?: string, logger?: { warn?: Function } }} options
 * @returns {Array<{ name: string, description: string, whenToUse?: string, invocation: { modelInvocable: boolean, userInvocable: boolean }, path: string, directory: string, source: string, root: string }>}
 */
export function discoverSkills(options = {}) {
  const dshHome = typeof options.dshHome === 'string' && options.dshHome ? options.dshHome : undefined
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : undefined
  const managedDir =
    typeof options.managedDir === 'string' && options.managedDir ? options.managedDir : undefined
  const logger = options.logger
  const sources = Array.isArray(options.sources) ? options.sources : []

  /** @type {Array<{ path: string, source: string, skipSystem?: boolean }>} */
  const roots = []

  // 1) 托管技能目录
  if (managedDir) roots.push({ path: managedDir, source: 'managed' })

  // 2) 用户添加的额外来源目录
  for (const item of sources) {
    const path = typeof item === 'string' ? item : item && typeof item.path === 'string' ? item.path : ''
    if (path) roots.push({ path, source: 'source' })
  }

  // 3) 项目级目录（仅当 cwd 真的存在）
  if (cwd && isDirectory(cwd)) {
    roots.push({ path: join(cwd, '.dsh', 'skills'), source: 'project' })
    roots.push({ path: join(cwd, '.agents', 'skills'), source: 'project' })
  }

  // 4) 用户级目录（跳过 `.system`）
  if (dshHome) roots.push({ path: join(dshHome, 'skills'), source: 'user', skipSystem: true })

  /** @type {ReturnType<typeof collectFromRoot>} */
  const entries = []
  const seen = new Set()

  for (const root of roots) {
    for (const skill of collectFromRoot(root, logger)) {
      if (seen.has(skill.name)) continue // 同名保留先发现的（高优先级 root）
      seen.add(skill.name)
      entries.push(skill)
    }
  }
  return entries
}

/**
 * 扫描一个 root 的一层条目。
 * @param {{ path: string, source: string, skipSystem?: boolean }} root
 * @param {{ warn?: Function } | undefined} logger
 */
function collectFromRoot(root, logger) {
  let dirents
  try {
    dirents = readdirSync(root.path, { withFileTypes: true })
  } catch {
    return [] // root 不存在 / 无权限：静默跳过
  }

  const found = []
  // 排序只为了让结果稳定（便于测试与展示）
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const dirent of dirents) {
    const name = dirent.name
    if (!name || name.startsWith('.') || name === 'node_modules') continue
    if (root.skipSystem && name === '.system') continue

    const fullPath = join(root.path, name)
    try {
      const kind = entryKind(fullPath, dirent)

      if (kind === 'directory') {
        const skill = readSkill(join(fullPath, 'SKILL.md'), {
          fallbackName: name,
          directory: fullPath,
          root: root.path,
          source: root.source,
          logger,
        })
        if (skill) found.push(skill)
        continue
      }

      if (kind === 'file' && name.endsWith('.md')) {
        const base = name.slice(0, -'.md'.length)
        // 扁平文件：文件名本身必须是 kebab-case 才收录
        if (!isSkillName(base)) continue
        const skill = readSkill(fullPath, {
          fallbackName: base,
          directory: root.path,
          root: root.path,
          source: root.source,
          logger,
        })
        if (skill) found.push(skill)
      }
    } catch (error) {
      logger?.warn?.(`skill-switch: failed to scan ${fullPath}: ${errorText(error)}`)
    }
  }
  return found
}

/**
 * 读取并解析一个 SKILL.md。
 * @param {string} filePath
 * @param {{ fallbackName: string, directory: string, root: string, source: string, logger?: { warn?: Function } }} meta
 */
function readSkill(filePath, meta) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return undefined // 目录里没有 SKILL.md：不是错误
  }

  const { data, body } = parseFrontmatter(raw)

  for (const legacy of LEGACY_INVOCATION_KEYS) {
    if (Object.hasOwn(data, legacy)) {
      meta.logger?.warn?.(
        `skill-switch: ${filePath} uses legacy invocation key "${legacy}", skill skipped`,
      )
      return undefined
    }
  }

  const frontmatterName =
    typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined
  const name = frontmatterName ?? meta.fallbackName
  if (!isSkillName(name)) {
    meta.logger?.warn?.(
      `skill-switch: ${filePath} has invalid skill name "${name}" (must be kebab-case), skipped`,
    )
    return undefined
  }

  const description =
    (typeof data.description === 'string' ? data.description.trim() : '') ||
    firstContentLine(body) ||
    name

  const whenToUse =
    typeof data.whenToUse === 'string' && data.whenToUse.trim()
      ? data.whenToUse.trim()
      : undefined

  const entry = {
    name,
    description,
    invocation: {
      modelInvocable: data['disable-model-invocation'] !== true,
      userInvocable: data['user-invocable'] !== false,
    },
    path: filePath,
    directory: meta.directory,
    source: meta.source,
    root: meta.root,
  }
  if (whenToUse) entry.whenToUse = whenToUse
  return entry
}

/** body 的第一行非空内容，作为没有 description 时的兜底 */
function firstContentLine(body) {
  if (typeof body !== 'string') return ''
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** 判断一个 dirent 实际是目录 / 文件（symlink 走 stat 兜底） */
function entryKind(fullPath, dirent) {
  try {
    if (dirent.isDirectory()) return 'directory'
    if (dirent.isFile()) return 'file'
    if (dirent.isSymbolicLink()) {
      const stat = statSync(fullPath)
      if (stat.isDirectory()) return 'directory'
      if (stat.isFile()) return 'file'
    }
  } catch {
    return undefined
  }
  return undefined
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function errorText(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
