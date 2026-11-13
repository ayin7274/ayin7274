/**
 * lib/http.js —— 挂载在 `/api/skill-switch` 前缀下的 HTTP 接口
 *
 * 契约（SPEC §7）：
 *  - GET  /state?sessionId=&cwd=
 *  - POST /toggle、/reset-session、/reset-sessions、/source、/managed
 *  - 成功 200 + §7.1 payload；校验错误 400 {ok:false,error}；内部错误 500
 *  - 未知路径/方法 404 {ok:false,error:'not found'}；body 解析失败 400
 */

const PREFIX = '/api/skill-switch'
const MAX_BODY_BYTES = 256 * 1024

/**
 * @param {{ list: Function, toggle: Function, resetSession: Function, resetSessions: Function, addSource: Function, removeSource: Function, addManaged: Function, removeManaged: Function }} service
 * @param {{ warn?: Function }} [logger]
 */
export function createHandler(service, logger) {
  return async function skillSwitchHandler(req, res) {
    try {
      const url = new URL(typeof req?.url === 'string' ? req.url : '/', 'http://127.0.0.1')
      const routePath = stripPrefix(url.pathname)
      if (routePath === null) return sendJson(res, 404, { ok: false, error: 'not found' })

      const method = String(req?.method ?? 'GET').toUpperCase()

      if (method === 'GET' && routePath === '/state') {
        const payload = await service.list({
          sessionId: queryParam(url, 'sessionId'),
          cwd: queryParam(url, 'cwd'),
        })
        return sendJson(res, 200, payload)
      }

      if (method !== 'POST') return sendJson(res, 404, { ok: false, error: 'not found' })

      const body = await readJsonBody(req)

      switch (routePath) {
        case '/toggle': {
          // §7.2：scope 必填，避免客户端漏传时悄悄落到 session
          if (body.scope !== 'session' && body.scope !== 'global') {
            throw badRequest("scope must be 'session' or 'global'")
          }
          const payload = await service.toggle({
            name: body.name,
            scope: body.scope,
            sessionId: body.sessionId,
            cwd: body.cwd,
            disabled: body.disabled,
          })
          return sendJson(res, 200, payload)
        }

        case '/reset-session': {
          const payload = await service.resetSession({
            sessionId: body.sessionId,
            cwd: body.cwd,
          })
          return sendJson(res, 200, payload)
        }

        case '/reset-sessions': {
          const payload = await service.resetSessions({ cwd: body.cwd })
          return sendJson(res, 200, payload)
        }

        case '/source': {
          if (body.action === 'add') {
            return sendJson(res, 200, await service.addSource(body.path))
          }
          if (body.action === 'remove') {
            return sendJson(res, 200, await service.removeSource(body.path))
          }
          throw badRequest("action must be 'add' or 'remove'")
        }

        case '/managed': {
          if (body.action === 'add') {
            return sendJson(
              res,
              200,
              await service.addManaged({
                name: body.name,
                description: body.description,
                content: body.content,
              }),
            )
          }
          if (body.action === 'remove') {
            return sendJson(res, 200, await service.removeManaged(body.name))
          }
          throw badRequest("action must be 'add' or 'remove'")
        }

        default:
          return sendJson(res, 404, { ok: false, error: 'not found' })
      }
    } catch (error) {
      const status = error?.status === 400 ? 400 : 500
      if (status === 500) {
        logger?.warn?.(`skill-switch: http error: ${errorText(error)}`)
      }
      return sendJson(res, status, { ok: false, error: errorText(error) })
    }
  }
}

/** 剥掉前缀；不匹配返回 null，根路径返回 '/' */
function stripPrefix(pathname) {
  if (pathname === PREFIX) return '/'
  if (!pathname.startsWith(`${PREFIX}/`)) return null
  return pathname.slice(PREFIX.length) || '/'
}

function queryParam(url, name) {
  const value = url.searchParams.get(name)
  return value === null || value === '' ? undefined : value
}

/** 读取 JSON body：空 → {}；非法 JSON / 非对象 / 超限 → status=400 的 Error */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function') {
      resolve({})
      return
    }

    const chunks = []
    let size = 0
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    req.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        finish(reject, badRequest('request body too large'))
        try {
          req.destroy?.()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(buffer)
    })

    req.on('end', () => {
      if (settled) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        finish(resolve, {})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        finish(reject, badRequest('invalid JSON body'))
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        finish(reject, badRequest('body must be a JSON object'))
        return
      }
      finish(resolve, parsed)
    })

    req.on('error', (error) => finish(reject, error))
  })
}

function sendJson(res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch {
    /* 响应可能已被对端断开：忽略 */
  }
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function errorText(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
