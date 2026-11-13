/**
 * dsh-skill-switch —— host 半端入口
 *
 * 契约（SPEC §2）：注册 skill provider（rank 0/1 覆盖）、`skill_switch` 工具、
 * `/api/skill-switch` HTTP 前缀。
 *
 * 硬约束：apply 绝不抛错（DSH 激活失败会整条 warn 掉）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSkillSwitch } from './lib/skill-switch.js'
import { createHandler } from './lib/http.js'

export const name = 'skill-switch'
export const inject = ['skills', 'tools', 'webServer', 'workingDirectory', 'agents']

export function apply(ctx, config) {
  void config

  const logger = ctx?.logger
  try {
    const dshHome = resolveDshHome(ctx)
    const service = createSkillSwitch({ ctx, dshHome, logger })
    const handler = createHandler(service, logger)

    // 1) provider：rank 0 影子（禁用）/ rank 1 真实（会话开启、额外来源、托管技能）
    try {
      ctx.skills.registerProvider((control) => {
        if (control && typeof control.invalidate === 'function') {
          service.setInvalidate(() => control.invalidate())
        }
        return service.provider()
      })
    } catch (error) {
      warn(logger, 'registerProvider failed', error)
    }

    // 2) agent 工具
    try {
      ctx.tools.register(skillSwitchTool(ctx, service))
    } catch (error) {
      warn(logger, 'tools.register failed', error)
    }

    // 3) HTTP（挂在 webServer 上，dispose 交给 effect）
    try {
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/skill-switch',
            handler,
          }),
        'skill-switch-http',
      )
    } catch (error) {
      warn(logger, 'webServer.register failed', error)
    }
  } catch (error) {
    warn(logger, 'apply failed', error)
  }
}

/** dshHome：`ctx.get('dshHomePath')` 是函数（历史事故：别当字符串用） */
function resolveDshHome(ctx) {
  try {
    const provider = ctx?.get?.('dshHomePath')
    if (typeof provider === 'function') {
      const value = provider()
      if (typeof value === 'string' && value) return value
    } else if (typeof provider === 'string' && provider) {
      return provider
    }
  } catch {
    /* fallthrough */
  }
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** @param {any} ctx @param {any} service */
function skillSwitchTool(ctx, service) {
  return {
    name: 'skill_switch',
    description:
      'List, enable or disable skills for the current session, or manage global defaults. Session changes override global settings.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list',
            'set',
            'reset_session',
            'reset_sessions',
            'add_source',
            'remove_source',
            'add_skill',
            'remove_skill',
            'refresh',
          ],
        },
        name: { type: 'string' },
        scope: { type: 'string', enum: ['session', 'global'] },
        disabled: { type: 'boolean' },
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        path: { type: 'string' },
        description: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          data: { type: 'object' },
        },
        required: ['ok', 'message'],
      },
      render: (args, value) => [{ type: 'text', text: value?.message ?? '' }],
    },

    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      try {
        const action = typeof input.action === 'string' ? input.action : ''
        if (!action) return fail('action is required')

        const sessionId = resolveSessionId(input, exec)
        const cwd = await resolveToolCwd(ctx, input, exec)

        switch (action) {
          case 'list': {
            const data = await service.list({ sessionId, cwd })
            return ok(formatList(data), data)
          }

          case 'set': {
            const name = stringArg(input.name)
            if (!name) return fail('name is required for set')
            if (typeof input.disabled !== 'boolean') {
              return fail('disabled must be a boolean for set')
            }
            const scope = input.scope === undefined ? 'session' : input.scope
            if (scope !== 'session' && scope !== 'global') {
              return fail("scope must be 'session' or 'global'")
            }
            const data = await service.toggle({
              name,
              scope,
              sessionId,
              cwd,
              disabled: input.disabled,
            })
            const where = scope === 'global' ? 'globally' : 'for this session'
            return ok(
              `Skill "${name}" ${input.disabled ? 'disabled' : 'enabled'} ${where}.`,
              data,
            )
          }

          case 'reset_session': {
            if (!sessionId) return fail('sessionId is required for reset_session')
            const data = await service.resetSession({ sessionId, cwd })
            return ok(`Session overrides cleared for ${sessionId}.`, data)
          }

          case 'reset_sessions': {
            const data = await service.resetSessions({ cwd })
            return ok('All session overrides cleared.', data)
          }

          case 'add_source': {
            const path = stringArg(input.path)
            if (!path) return fail('path is required for add_source')
            const data = await service.addSource(path)
            return ok(`Added skill source: ${path}`, data)
          }

          case 'remove_source': {
            const path = stringArg(input.path)
            if (!path) return fail('path is required for remove_source')
            const data = await service.removeSource(path)
            return ok(`Removed skill source: ${path}`, data)
          }

          case 'add_skill': {
            const name = stringArg(input.name)
            if (!name) return fail('name is required for add_skill')
            const description = stringArg(input.description)
            if (!description) return fail('description is required for add_skill')
            const data = await service.addManaged({
              name,
              description,
              content: typeof input.content === 'string' ? input.content : '',
            })
            return ok(`Created managed skill "${name}".`, data)
          }

          case 'remove_skill': {
            const name = stringArg(input.name)
            if (!name) return fail('name is required for remove_skill')
            const data = await service.removeManaged(name)
            return ok(`Removed managed skill "${name}".`, data)
          }

          case 'refresh': {
            service.invalidate()
            return ok('Skill catalog refreshed.')
          }

          default:
            return fail(`unknown action "${action}"`)
        }
      } catch (error) {
        return fail(errorText(error))
      }
    },
  }
}

/** sessionId：显式参数优先，否则取当前 agent 的 session id */
function resolveSessionId(input, exec) {
  const explicit = stringArg(input.sessionId)
  if (explicit) return explicit
  try {
    const id = exec?.agent?.session?.id
    if (typeof id === 'string' && id) return id
  } catch {
    /* ignore */
  }
  return null
}

/** cwd：优先宿主 ensure() 的结果，失败回退 args.cwd（SPEC §8） */
async function resolveToolCwd(ctx, input, exec) {
  let ensured
  if (exec?.agent) {
    try {
      const workingDirectory = ctx?.workingDirectory ?? ctx?.get?.('workingDirectory')
      if (workingDirectory && typeof workingDirectory.ensure === 'function') {
        ensured = await workingDirectory.ensure(exec.agent, exec.signal)
      }
    } catch {
      ensured = undefined
    }
  }
  if (typeof ensured === 'string' && ensured) return ensured
  return stringArg(input.cwd)
}

/** list 的多行 message（SPEC §8） */
function formatList(payload) {
  const sessionId = payload?.sessionId ?? 'none'
  const cwd = payload?.cwd ?? 'unknown'
  const lines = [`Skills for session ${sessionId} (cwd=${cwd})`]
  const skills = Array.isArray(payload?.skills) ? payload.skills : []
  if (skills.length === 0) lines.push('- (no skills found)')
  for (const skill of skills) {
    lines.push(
      `- [${skill.enabled ? 'on' : 'off'}] ${skill.name} (${skill.source}) — ${skill.description}`,
    )
  }
  return lines.join('\n')
}

function ok(message, data) {
  return data === undefined ? { ok: true, message } : { ok: true, message, data }
}

function fail(message) {
  return { ok: false, message: typeof message === 'string' && message ? message : 'skill_switch failed' }
}

function stringArg(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function warn(logger, message, error) {
  try {
    logger?.warn?.(`skill-switch: ${message}: ${errorText(error)}`)
  } catch {
    /* ignore */
  }
}

function errorText(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
