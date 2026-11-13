/**
 * lib/frontmatter.js —— 容错的 SKILL.md frontmatter 解析与序列化
 *
 * 契约（SPEC §3）：
 *  - parseFrontmatter(text) → { data, body }
 *  - serializeSkill({ name, description, whenToUse, content }) → '---\n...\n---\n<body>\n'
 *
 * 只实现我们真正用到的 YAML 子集：`key: scalar`、单双引号、`|` / `>` 块、true/false。
 * 解析永远不抛错 —— 认不出来的行直接忽略，语义校验交给 scan.js（那里会 warn + skip）。
 */

const KEBAB_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/

/**
 * 解析 `--- ... ---` frontmatter。
 * 允许输入带 BOM、CRLF；没有 frontmatter 时返回 { data: {}, body: text }（body 保留原文）。
 * @param {string} text
 * @returns {{ data: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const firstLineEnd = normalized.indexOf('\n')
  // 连一行都没走完（或首行不是 ---）：没有 frontmatter
  if (firstLineEnd < 0 || normalized.slice(0, firstLineEnd) !== '---') {
    return { data: {}, body: raw }
  }

  const lines = normalized.split('\n')
  let closing = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].replace(/[ \t]+$/, '') === '---') {
      closing = i
      break
    }
  }
  // 只有开头的 `---` 没有收尾：按「没有 frontmatter」处理（容错）
  if (closing < 0) return { data: {}, body: raw }

  return {
    data: parseHeaderLines(lines.slice(1, closing)),
    body: lines.slice(closing + 1).join('\n'),
  }
}

/**
 * 序列化托管技能。
 * 描述里的换行由调用方拒绝；这里也做一层兜底（换行折成空格），保证写出来的 YAML 永远单行。
 * @param {{ name?: string, description?: string, whenToUse?: string, content?: string }} skill
 * @returns {string}
 */
export function serializeSkill({ name, description, whenToUse, content } = {}) {
  const lines = [
    '---',
    `name: ${yamlScalar(oneLine(name))}`,
    `description: ${yamlScalar(oneLine(description))}`,
  ]
  const when = oneLine(whenToUse).trim()
  if (when) lines.push(`whenToUse: ${yamlScalar(when)}`)
  lines.push('---')
  const body = String(content ?? '').replace(/\r\n?/g, '\n').trim()
  return `${lines.join('\n')}\n${body}\n`
}

/** 把字段值折成单行（多行描述不允许，但序列化侧兜底） */
function oneLine(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' ')
}

/** 需要引号的场景才用 JSON 双引号（JSON 转义是 YAML 双引号的子集） */
function yamlScalar(value) {
  const text = String(value ?? '')
  if (text === '') return '""'
  const plainSafe =
    /^[A-Za-z0-9_][A-Za-z0-9_ .,;:!?()[\]{}@#$%&*+=<>|~^/\\-]*$/.test(text) &&
    !/(^|\s)#/.test(text) &&
    !/:\s/.test(text) &&
    text === text.trim()
  if (plainSafe) return text
  return JSON.stringify(text)
}

/**
 * 逐行解析 frontmatter 主体。
 * 无法识别的行直接跳过 —— 契约要求「尽量容错、不抛错」。
 */
function parseHeaderLines(lines) {
  const data = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i += 1
      continue
    }

    const match = KEBAB_LINE.exec(line)
    if (!match) {
      // 例如嵌套结构 / 数组续行：本子集不支持，忽略
      i += 1
      continue
    }
    const key = match[1]
    const rest = match[2].trim()

    // 块标量：| / >，可带 chomping（- / +）与缩进提示数字
    const block = /^([|>])([+-]?)([1-9]?)$/.exec(rest)
    if (block) {
      const style = block[1]
      const chomp = block[2] === '-' ? 'strip' : block[2] === '+' ? 'keep' : 'clip'
      i += 1
      const blockLines = []
      while (i < lines.length) {
        const current = lines[i]
        if (current.trim() === '') {
          blockLines.push('')
          i += 1
          continue
        }
        if (!/^[ \t]/.test(current)) break // 顶格 ⇒ 块结束
        blockLines.push(current)
        i += 1
      }
      data[key] = renderBlock(blockLines, style, chomp)
      continue
    }

    data[key] = parseScalar(rest)
    i += 1
  }
  return data
}

/** 去掉块缩进并按 `|` / `>` 语义拼回文本 */
function renderBlock(blockLines, style, chomp) {
  const nonEmpty = blockLines.filter((line) => line.trim() !== '')
  const indent = nonEmpty.length
    ? Math.min(...nonEmpty.map((line) => /^[ \t]*/.exec(line)[0].length))
    : 0
  const content = blockLines.map((line) => line.slice(Math.min(indent, line.length)))

  let text = style === '>' ? foldLines(content) : content.join('\n')
  text = text.replace(/\n+$/, '')
  if (chomp !== 'strip' && text.length > 0) text += '\n'
  return text
}

/** YAML 折叠：相邻非空行用空格连接，空行保留为换行 */
function foldLines(lines) {
  let out = ''
  for (const line of lines) {
    if (line === '') {
      out += '\n'
      continue
    }
    if (out.length > 0 && !out.endsWith('\n')) out += ' '
    out += line
  }
  return out
}

/** 解析单个标量值：布尔 / 引号 / 普通字符串；普通值会剥掉行尾注释 */
function parseScalar(rest) {
  const value = rest.trim()
  if (value === '') return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (value.startsWith('"')) return parseDoubleQuoted(value)
  if (value.startsWith("'")) return parseSingleQuoted(value)
  // 普通标量：` #` 之后是注释
  return value.replace(/\s+#.*$/, '').trim()
}

function parseDoubleQuoted(value) {
  let escaped = false
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      const quoted = value.slice(0, i + 1)
      try {
        return JSON.parse(quoted)
      } catch {
        return quoted.slice(1, -1)
      }
    }
  }
  // 引号没闭合：尽量容错，剥掉开头的引号
  return value.slice(1)
}

function parseSingleQuoted(value) {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] !== "'") continue
    if (value[i + 1] === "'") {
      i += 1 // '' 是转义的单引号
      continue
    }
    return value.slice(1, i).replace(/''/g, "'")
  }
  return value.slice(1)
}
