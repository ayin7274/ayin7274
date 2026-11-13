#!/usr/bin/env node
/**
 * scripts/selfcheck-host.mjs —— host 半端自检（SPEC §11）
 *
 * 在一个临时 DSH_HOME 下用 fake ctx 跑 apply()，然后断言：
 *   1) provider / tool / HTTP 路由注册成功
 *   2) discoverSkills 能解析 SKILL.md
 *   3) effective 四条规则
 *   4) provider rank 0（禁用影子）/ rank 1（会话开启、额外来源、托管）
 *   5) managed / source 写操作与 state
 *   6) HTTP GET /state、POST /toggle、404、400
 *
 * 退出码：全部通过 0，失败 1。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { discoverSkills } from '../lib/scan.js'
import { effective, loadState } from '../lib/state.js'

const DISABLED_CONTENT =
  'This skill is disabled for the current session. Enable it in Settings → Skill Switch or via the session skill panel.'

async function main() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-skill-switch-'))
  const workspace = join(tmpHome, 'workspace')
  const userSkills = join(tmpHome, 'skills')
  const stateFile = join(tmpHome, 'skill-switch', 'state.json')
  const managedDir = join(tmpHome, 'skill-switch', 'skills')

  mkdirSync(workspace, { recursive: true })
  writeSkill(join(userSkills, 'alpha'), 'alpha', 'Alpha skill for selfcheck.')
  writeSkill(join(userSkills, 'beta'), 'beta', 'Beta skill for selfcheck.')

  try {
    // -----------------------------------------------------------------------
    // 0) fake ctx + apply
    // -----------------------------------------------------------------------
    const captured = {
      providerFactory: null,
      tool: null,
      route: null,
      invalidated: 0,
    }
    const fakeCtx = {
      logger: { debug() {}, info() {}, warn() {} },
      get(key) {
        if (key === 'dshHomePath') return (...segments) => join(tmpHome, ...segments)
        if (key === 'workingDirectory') {
          return { defaultDirectory: workspace, ensure: async () => workspace }
        }
        if (key === 'agents') return { get: () => undefined }
        return undefined
      },
      skills: {
        registerProvider(factory) {
          captured.providerFactory = factory
        },
        async snapshot() {
          return { skills: [], complete: true }
        },
      },
      tools: {
        register(tool) {
          captured.tool = tool
        },
      },
      webServer: {
        register(route) {
          captured.route = route
        },
      },
      effect(fn) {
        return fn()
      },
    }

    apply(fakeCtx, {})
    assert.ok(captured.providerFactory, 'apply 未注册 provider')
    assert.ok(captured.tool, 'apply 未注册 tool')
    assert.ok(captured.route, 'apply 未注册 HTTP route')
    assert.equal(captured.route.kind, 'prefix', 'HTTP route kind 应为 prefix')
    assert.equal(captured.route.path, '/api/skill-switch', 'HTTP route path 不符')
    assert.equal(captured.tool.name, 'skill_switch', 'tool name 不符')

    // -----------------------------------------------------------------------
    // 1) discoverSkills 解析
    // -----------------------------------------------------------------------
    const discovered = discoverSkills({ dshHome: tmpHome, cwd: workspace, managedDir })
    const alphaEntry = discovered.find((item) => item.name === 'alpha')
    assert.ok(alphaEntry, 'discoverSkills 未发现 alpha')
    assert.equal(alphaEntry.description, 'Alpha skill for selfcheck.')
    assert.deepEqual(alphaEntry.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(alphaEntry.source, 'user')
    assert.ok(existsSync(alphaEntry.path))

    // -----------------------------------------------------------------------
    // 2) effective 四条规则
    // -----------------------------------------------------------------------
    const sampleState = {
      version: 1,
      global: { disabled: { alpha: { description: 'a' }, gamma: {} } },
      sessions: {
        s1: { enabled: { alpha: {} }, disabled: { beta: {} } },
      },
      sources: [],
    }
    assert.deepEqual(effective(sampleState, 's1', 'alpha'), {
      enabled: true,
      reason: 'session-enabled',
    })
    assert.deepEqual(effective(sampleState, 's1', 'beta'), {
      enabled: false,
      reason: 'session-disabled',
    })
    assert.deepEqual(effective(sampleState, null, 'gamma'), { enabled: false, reason: 'global' })
    assert.deepEqual(effective(sampleState, null, 'delta'), { enabled: true, reason: 'default' })

    // provider 工厂：注册一次，拿到 provider 与 control
    const control = {
      invalidate() {
        captured.invalidated += 1
      },
    }
    const provider = captured.providerFactory(control)
    assert.equal(provider.name, 'skill-switch', 'provider.name 不符')
    for (const method of ['list', 'get']) {
      assert.equal(typeof provider[method], 'function', `provider.${method} 缺失`)
    }

    // 普通默认开启的技能不应由本 provider 发出
    assert.deepEqual(await provider.list({ cwd: workspace }), [], '默认开启技能不应输出候选')

    const callTool = (args, exec = {}) => captured.tool.execute(args, exec)
    const assertOk = (result, label) => {
      assert.equal(result.ok, true, `${label}: ${result.message}`)
      return result.data
    }
    const assertFail = (result, label) => {
      assert.equal(result.ok, false, `${label} 应失败`)
      return result.message
    }

    // -----------------------------------------------------------------------
    // 3) 全局禁用 → rank 0 影子候选
    // -----------------------------------------------------------------------
    const disabledData = assertOk(
      await callTool({ action: 'set', scope: 'global', name: 'alpha', disabled: true }),
      'global disable alpha',
    )
    assert.deepEqual(disabledData.globalDisabled, ['alpha'])
    assert.ok(captured.invalidated >= 1, '写操作后应调用 control.invalidate()')
    assert.ok(existsSync(stateFile), 'state.json 应已落盘')

    let candidates = await provider.list({ cwd: workspace })
    assert.equal(candidates.length, 1, '全局禁用后应只有 alpha 影子候选')
    const shadow = candidates[0]
    assertCandidate(shadow)
    assert.equal(shadow.name, 'alpha')
    assert.equal(shadow.rank, 0)
    assert.equal(shadow.source, 'disabled')
    assert.deepEqual(shadow.invocation, { modelInvocable: false, userInvocable: false })

    const shadowDef = await provider.get(shadow)
    assert.equal(shadowDef.content, DISABLED_CONTENT, '禁用技能定义内容不符')
    assert.deepEqual(shadowDef.invocation, { modelInvocable: false, userInvocable: false })

    // -----------------------------------------------------------------------
    // 4) 会话显式启用 → rank 1 真实候选；reset 后回 rank 0
    // -----------------------------------------------------------------------
    assertOk(
      await callTool({
        action: 'set',
        scope: 'session',
        sessionId: 's1',
        name: 'alpha',
        disabled: false,
      }),
      'session enable alpha',
    )
    candidates = await provider.list({ cwd: workspace, scope: { session: { id: 's1' } } })
    assert.equal(candidates.length, 1, '会话开启 alpha 后应有真实候选')
    const real = candidates[0]
    assertCandidate(real)
    assert.equal(real.name, 'alpha')
    assert.equal(real.rank, 1)
    assert.equal(real.source, 'user')
    assert.equal(real.locator.kind, 'file')
    assert.deepEqual(real.resourceBase, { kind: 'directory', path: join(userSkills, 'alpha') })
    assert.notEqual(real.source, 'disabled')

    const realDef = await provider.get(real)
    assert.equal(realDef.name, 'alpha')
    assert.equal(realDef.provider, 'skill-switch')
    assert.equal(realDef.source, 'user')
    assert.ok(realDef.content.includes('Body for alpha.'))
    assert.equal(typeof realDef.path, 'string')

    // 默认 cwd / session 解析：通过 tool list 走一遍 exec.agent
    const listData = assertOk(
      await callTool(
        { action: 'list' },
        { agent: { session: { id: 's1' }, id: 'agent-1' } },
      ),
      'tool list',
    )
    assert.equal(listData.sessionId, 's1', 'tool list 应使用 exec.agent.session.id')
    assert.equal(listData.cwd, workspace, 'tool list 应使用 workingDirectory.ensure 结果')

    assertOk(await callTool({ action: 'reset_session', sessionId: 's1' }), 'reset_session s1')
    candidates = await provider.list({ cwd: workspace, scope: { session: { id: 's1' } } })
    assert.equal(candidates[0]?.rank, 0, 'reset 后 alpha 应回 rank 0（全局仍禁用）')

    // -----------------------------------------------------------------------
    // 5) 会话级启用/禁用（无全局禁用时）
    // -----------------------------------------------------------------------
    assertOk(
      await callTool({ action: 'set', scope: 'session', sessionId: 's2', name: 'beta', disabled: true }),
      'session disable beta',
    )
    candidates = await provider.list({ cwd: workspace, scope: { session: { id: 's2' } } })
    const betaShadow = candidates.find((item) => item.name === 'beta')
    assert.ok(betaShadow, '会话禁用 beta 后应有 beta 影子候选')
    assert.equal(betaShadow.rank, 0)

    assertOk(
      await callTool({ action: 'set', scope: 'session', sessionId: 's2', name: 'beta', disabled: false }),
      'session enable beta',
    )
    candidates = await provider.list({ cwd: workspace, scope: { session: { id: 's2' } } })
    assert.ok(!candidates.some((item) => item.name === 'beta'), '无全局禁用时会话启用应回到默认，不再输出')

    // -----------------------------------------------------------------------
    // 6) 托管技能：add → 文件 + rank 1 + payload.managed
    // -----------------------------------------------------------------------
    const managedData = assertOk(
      await callTool({
        action: 'add_skill',
        name: 'managed-skill',
        description: 'Managed skill for selfcheck.',
        content: '# Managed\n\nBody for managed-skill.',
      }),
      'add_skill',
    )
    const managedFile = join(managedDir, 'managed-skill', 'SKILL.md')
    assert.ok(existsSync(managedFile), '托管技能文件应存在')
    const managedRaw = readFileSync(managedFile, 'utf8')
    assert.ok(managedRaw.startsWith('---'), '托管技能应有 frontmatter')
    assert.deepEqual(
      managedData.managed.map((item) => item.name),
      ['managed-skill'],
    )

    candidates = await provider.list({ cwd: workspace })
    const managedCandidate = candidates.find((item) => item.name === 'managed-skill')
    assert.ok(managedCandidate, '托管技能应有 rank 1 候选')
    assertCandidate(managedCandidate)
    assert.equal(managedCandidate.rank, 1)
    assert.equal(managedCandidate.source, 'managed')

    const managedSkill = managedData.skills.find((item) => item.name === 'managed-skill')
    assert.equal(managedSkill.managed, true)
    assert.equal(managedSkill.enabled, true)
    assert.equal(managedSkill.missing, false)

    assertFail(
      await callTool({
        action: 'add_skill',
        name: 'managed-skill',
        description: 'duplicate',
      }),
      'duplicate add_skill',
    )

    // -----------------------------------------------------------------------
    // 7) 额外来源目录：add → payload.skills + rank 1
    // -----------------------------------------------------------------------
    const extraRoot = join(tmpHome, 'extra-skills')
    writeSkill(join(extraRoot, 'extra-skill'), 'extra-skill', 'Extra skill from added source.')
    const sourceData = assertOk(
      await callTool({ action: 'add_source', path: extraRoot }),
      'add_source',
    )
    assert.deepEqual(sourceData.sources.map((item) => item.path), [extraRoot])
    const extraSkill = sourceData.skills.find((item) => item.name === 'extra-skill')
    assert.ok(extraSkill, 'payload.skills 应包含额外来源技能')
    assert.equal(extraSkill.source, 'source')

    candidates = await provider.list({ cwd: workspace })
    const extraCandidate = candidates.find((item) => item.name === 'extra-skill')
    assert.ok(extraCandidate, '额外来源技能应有 rank 1 候选')
    assertCandidate(extraCandidate)
    assert.equal(extraCandidate.rank, 1)
    assert.equal(extraCandidate.source, 'source')

    assertFail(await callTool({ action: 'add_source', path: extraRoot }), 'duplicate add_source')

    // -----------------------------------------------------------------------
    // 8) HTTP：GET /state、POST /toggle、400、404
    // -----------------------------------------------------------------------
    const http = captured.route.handler

    const getState = await httpRequest(http, {
      url: `/api/skill-switch/state?sessionId=s3&cwd=${encodeURIComponent(workspace)}`,
    })
    assert.equal(getState.status, 200, 'GET /state 应 200')
    assert.match(String(getState.headers?.['content-type']), /application\/json/)
    const payload = getState.body
    for (const key of [
      'ok',
      'sessionId',
      'cwd',
      'globalDisabled',
      'session',
      'sessionsWithOverrides',
      'sources',
      'managed',
      'skills',
    ]) {
      assert.ok(key in payload, `GET /state payload 缺字段 ${key}`)
    }
    assert.equal(payload.ok, true)
    assert.equal(payload.sessionId, 's3')
    assert.equal(payload.cwd, workspace)
    assert.equal(payload.session, null, '无覆盖的会话 session 应为 null')
    assert.deepEqual(payload.globalDisabled, ['alpha'])
    for (const skill of payload.skills) {
      for (const key of [
        'name',
        'description',
        'source',
        'path',
        'enabled',
        'reason',
        'managed',
        'missing',
      ]) {
        assert.ok(key in skill, `skills 条目缺字段 ${key}`)
      }
    }
    const payloadAlpha = payload.skills.find((item) => item.name === 'alpha')
    assert.equal(payloadAlpha.enabled, false)
    assert.equal(payloadAlpha.reason, 'global')

    // POST /toggle：全局重新启用 alpha
    const toggled = await httpRequest(http, {
      url: '/api/skill-switch/toggle',
      method: 'POST',
      body: { name: 'alpha', scope: 'global', disabled: false, cwd: workspace },
    })
    assert.equal(toggled.status, 200, 'POST /toggle 应 200')
    assert.deepEqual(toggled.body.globalDisabled, [])
    candidates = await provider.list({ cwd: workspace })
    assert.ok(!candidates.some((item) => item.name === 'alpha'), '全局启用后 alpha 不应再有候选')

    // POST /toggle 缺 scope → 400
    const badToggle = await httpRequest(http, {
      url: '/api/skill-switch/toggle',
      method: 'POST',
      body: { name: 'alpha', disabled: true },
    })
    assert.equal(badToggle.status, 400, '缺 scope 的 toggle 应 400')
    assert.equal(badToggle.body.ok, false)

    // 未知路径 → 404
    assert.equal((await httpRequest(http, { url: '/api/skill-switch/nope' })).status, 404)
    assert.equal((await httpRequest(http, { url: '/elsewhere/state' })).status, 404)

    // -----------------------------------------------------------------------
    // 9) reset_sessions 清空所有会话覆盖
    // -----------------------------------------------------------------------
    assertOk(
      await callTool({ action: 'set', scope: 'session', sessionId: 's4', name: 'beta', disabled: true }),
      'session disable beta s4',
    )
    let state = loadState(stateFile)
    assert.equal(Object.keys(state.sessions).length, 1, 'reset 前应有 1 个会话')
    const resetData = assertOk(await callTool({ action: 'reset_sessions' }), 'reset_sessions')
    assert.deepEqual(resetData.sessionsWithOverrides, 0)
    assert.equal(resetData.session, null)
    state = loadState(stateFile)
    assert.deepEqual(state.sessions, {}, 'reset_sessions 后 sessions 应为空')

    // -----------------------------------------------------------------------
    // 10) remove managed / source + 参数校验不抛错
    // -----------------------------------------------------------------------
    const removedManaged = assertOk(
      await callTool({ action: 'remove_skill', name: 'managed-skill' }),
      'remove_skill',
    )
    assert.deepEqual(removedManaged.managed, [])
    assert.ok(!existsSync(join(managedDir, 'managed-skill')), '托管技能目录应已删除')
    assertFail(await callTool({ action: 'remove_skill', name: 'managed-skill' }), 'remove 不存在的托管技能')

    const removedSource = assertOk(
      await callTool({ action: 'remove_source', path: extraRoot }),
      'remove_source',
    )
    assert.deepEqual(removedSource.sources, [])
    assertFail(await callTool({ action: 'remove_source', path: extraRoot }), 'remove 不存在的来源')

    assertFail(await callTool({ action: 'set', name: 'Bad Name', scope: 'global', disabled: true }), '非法 name')
    assertFail(await callTool({ action: 'set', scope: 'global', disabled: true }), '缺 name')
    assertFail(await callTool({ action: 'set', name: 'alpha', scope: 'global', disabled: 'yes' }), 'disabled 非布尔')
    assertFail(await callTool({ action: 'reset_session' }), '缺 sessionId')
    assertFail(await callTool({ action: 'bogus-action' }), '未知 action')
    const refreshed = await callTool({ action: 'refresh' })
    assert.equal(refreshed.ok, true, 'refresh 应成功')

    // 工具返回 shape：ok/message，render 产出 text
    const rendered = captured.tool.output.render({}, refreshed)
    assert.ok(Array.isArray(rendered))
    assert.equal(rendered[0].type, 'text')
    assert.equal(rendered[0].text, refreshed.message)

    console.log('PASS host')
  } finally {
    rmSync(tmpHome, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// helpers

function writeSkill(dir, name, description) {
  mkdirSync(dir, { recursive: true })
  const body = `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nBody for ${name}.\n`
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8')
}

/** 按 registry.validateCandidate 的约束检查候选形状 */
function assertCandidate(candidate) {
  assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'candidate.name 必须 kebab-case')
  assert.ok(typeof candidate.description === 'string' && candidate.description.length > 0, 'candidate.description 缺失')
  assert.equal(typeof candidate.invocation?.modelInvocable, 'boolean')
  assert.equal(typeof candidate.invocation?.userInvocable, 'boolean')
  assert.equal(candidate.provider, 'skill-switch')
  assert.equal(typeof candidate.source, 'string')
  assert.equal(typeof candidate.rank, 'number')
  assert.ok(Number.isFinite(candidate.rank))
}

function fakeRequest({ url, method = 'GET', body }) {
  const listeners = new Map()
  const req = {
    url,
    method,
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return req
    },
    destroy() {},
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
  }

  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  // handler 先注册监听（readJsonBody 里），微任务再派发 data/end
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit('data', chunk)
    req.emit('end')
  })
  return req
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk)
    },
  }
}

async function httpRequest(handler, options) {
  const res = fakeResponse()
  await handler(fakeRequest(options), res)
  let body
  try {
    body = JSON.parse(res.body)
  } catch {
    body = undefined
  }
  return { status: res.statusCode, headers: res.headers, body }
}

main().catch((error) => {
  console.error('FAIL host')
  console.error(error)
  process.exitCode = 1
})
