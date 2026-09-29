import { createHash } from 'node:crypto'
import fss from 'node:fs'

const WIKI_FETCH_TIMEOUT_MS = 15000
const WIKI_FETCH_RETRIES = 2
// 单次尝试里留给单个 CDN 节点的等待时间，以及最多试几个节点（只有云崽的 mysFetch 认识这两项）
const WIKI_NODE_TIMEOUT_MS = 4000
const WIKI_NODE_RETRIES = 3
const WIKI_HEADERS = { 'user-agent': 'Mozilla/5.0' }
const MYS_ERROR_TAG = '[mys]'

/**
 * 米游社接口统一走云崽核心的 lib/common/mys.js：先测速挑节点，命中坏节点自动换 IP。
 * 插件要能装在没有这个模块的云崽上，所以这里动态解析一次；拿不到就退回全局 fetch，
 * 只是少了「换 IP」这一层，功能不受影响。
 */
const coreMysFetch = await import('../../../../../lib/common/mys.js')
  .then(m => (typeof m?.mysFetch === 'function' ? m.mysFetch : null))
  .catch(() => null)
if (!coreMysFetch) {
  globalThis.logger?.warn?.('[bookdex] 未找到云崽 lib/common/mys.js，退回全局 fetch（无节点优选）')
}
const netFetch = coreMysFetch || ((url, options) => fetch(url, options))

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

function selectorSignature(item = {}) {
  const normalized = stableValue({
    id: String(item.id || ''),
    jump_type: item.jump_type || '',
    content_id: item.content_id || '',
    content_type: item.content_type || ''
  })
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function transitionalSelectorSignature(item = {}) {
  const normalized = stableValue({
    id: String(item.id || ''),
    title: item.title || '',
    name: item.name || '',
    jump_type: item.jump_type || '',
    content_id: item.content_id || '',
    content_type: item.content_type || ''
  })
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function legacySelectorSignature(item = {}) {
  const normalized = stableValue({
    id: String(item.id || ''),
    title: item.title || '',
    name: item.name || '',
    ext: item.ext || '',
    icon: item.icon || '',
    cover: item.cover || '',
    jump_type: item.jump_type || '',
    content_id: item.content_id || '',
    content_type: item.content_type || '',
    area_id: item.area_id || '',
    cate_id: item.cate_id || '',
    tag_id: item.tag_id || ''
  })
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function selectorSigMatches(savedSig, item = {}) {
  if (!savedSig) return true
  const sig = String(savedSig)
  return sig === selectorSignature(item) || sig === transitionalSelectorSignature(item) || sig === legacySelectorSignature(item)
}

function hasUsableMeta(meta = {}, filePath = '') {
  return Boolean(meta && meta.id && filePath && fss.existsSync(filePath))
}

async function emitProgress(fn, payload) {
  if (typeof fn === 'function') await fn(payload)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getFetchErrorCode(error) {
  if (error?.cause?.code) return error.cause.code
  if (error?.code) return error.code
  return ['AbortError', 'TimeoutError'].includes(error?.name) ? error.name : ''
}

/** 云崽 mysFetch 的「候选节点全挂了」错误：消息里是 IP 和错误码，不该直接给用户看 */
function isMysNodeError(error) {
  return typeof error?.message === 'string' && error.message.startsWith(MYS_ERROR_TAG)
}

/** 把底层网络错误翻成给用户看的一句话；原始详情仍留在 error.cause 里供排查 */
function describeFetchFailure(error) {
  if (isMysNodeError(error)) return '所有线路均连接失败'
  if (error?.name === 'TimeoutError') return '请求超时'
  return error?.message || '请求失败'
}

function isRetryableFetchError(error) {
  const code = getFetchErrorCode(error)
  if (['AbortError', 'TimeoutError'].includes(code)) return true
  if (String(code).startsWith('UND_ERR_')) return true
  if (isMysNodeError(error)) return true
  if (error?.name === 'TypeError' && /fetch failed/i.test(error?.message || '')) return true
  const status = Number(error?.status || 0)
  return status === 429 || status >= 500
}

function makeWikiFetchError(message, { url, label, status, cause } = {}) {
  const code = getFetchErrorCode(cause)
  const suffix = code ? `（${code}）` : ''
  const error = new Error(`${message}${suffix}`)
  error.name = 'WikiFetchError'
  error.url = url ? String(url) : ''
  error.label = label || ''
  error.status = status
  error.cause = cause
  error.userMessage = `${label || '米游社/HoYoWiki 数据'}下载失败：${message}${suffix}。这通常是服务器到米游社接口的网络波动，不是图鉴数据损坏；请稍后重试。`
  return error
}

function formatFetchError(error) {
  if (error?.userMessage) return error.userMessage
  if (isMysNodeError(error)) {
    return '米游社/HoYoWiki 数据下载失败：所有线路均连接失败。这通常是服务器到米游社接口的网络波动，请稍后重试。'
  }
  const code = getFetchErrorCode(error)
  const suffix = code ? `（${code}）` : ''
  if (error?.name === 'TypeError' && /fetch failed/i.test(error?.message || '')) {
    return `米游社/HoYoWiki 数据下载失败${suffix}。这通常是服务器网络到米游社接口超时或被重置，请稍后重试。`
  }
  return error?.message || String(error)
}

async function fetchJson(url, { label = '', retries = WIKI_FETCH_RETRIES, timeoutMs = WIKI_FETCH_TIMEOUT_MS } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await netFetch(url, {
        headers: WIKI_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
        // 以下两项只有云崽的 mysFetch 认识：单节点等响应头的超时、最多试几个节点。
        // 单节点最长 4s、最多 3 个节点，整体仍受上面 15s 的 signal 兜底；全局 fetch 会直接忽略它们。
        timeout: WIKI_NODE_TIMEOUT_MS,
        retry: WIKI_NODE_RETRIES,
        // 重试时强制重新解析并重测节点：一次 DNS 查询可能整批返回不可达的 CDN 池，
        // 沿用 30 分钟池缓存会把坏池粘住，重试就永远打在同一批死节点上
        ...(attempt > 0 ? { ttl: 0 } : {})
      })
      if (!r.ok) {
        const error = makeWikiFetchError(`HTTP ${r.status}`, { url, label, status: r.status })
        if (attempt < retries && isRetryableFetchError(error)) {
          lastError = error
          await sleep(600 * (attempt + 1))
          continue
        }
        throw error
      }
      try {
        return await r.json()
      } catch (error) {
        throw makeWikiFetchError('接口返回内容不是有效 JSON', { url, label, cause: error })
      }
    } catch (error) {
      const wrapped = error?.name === 'WikiFetchError'
        ? error
        : makeWikiFetchError(describeFetchFailure(error), { url, label, cause: error })
      if (attempt < retries && isRetryableFetchError(error)) {
        lastError = wrapped
        await sleep(600 * (attempt + 1))
        continue
      }
      throw wrapped
    }
  }
  throw lastError || makeWikiFetchError('请求失败', { url, label })
}

async function fetchSelectorPage({ channelId, page, pageSize = 100, label = '' }) {
  const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
  u.searchParams.set('app_sn', 'ys_obc')
  u.searchParams.set('channel_id', String(channelId))
  u.searchParams.set('page', String(page))
  u.searchParams.set('page_size', String(pageSize))
  return fetchJson(u, { label: label || `频道 ${channelId} 第 ${page} 页` })
}

async function fetchEntryPageById(id) {
  const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
  u.searchParams.set('app_sn', 'ys_obc')
  u.searchParams.set('entry_page_id', String(id))
  const j = await fetchJson(u, { label: `条目 ${id}` })
  return j?.data?.page || null
}

export { selectorSignature, selectorSigMatches, hasUsableMeta, emitProgress, fetchEntryPageById, fetchSelectorPage, fetchJson, formatFetchError }
