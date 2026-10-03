/**
 * 扩展频道（图鉴类）：配置驱动的「频道 → 模块 → 子项」采集
 *
 * 观测枢的详情页是模块化的（modules → components(data) → 字段/子项），
 * 这里把「要哪些频道、每个频道要哪些模块、模块里要哪些子项」做成可配置项：
 *   - 配置存 data/cache/channels.json（webui 里勾选）
 *   - 模块清单从源页面自动发现并存 data/cache/modules.json（webui 可刷新）
 *   - 未勾选的模块/子项：图文都不进正文，也不落盘
 *   - 每个条目记下「配置指纹」，配置一变就判为过期，更新/强更时自动重拉
 */
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  dataRoot,
  cacheRoot,
  slugify,
  booksRoot,
  storyRoot,
  voiceRoot,
  plotRoot,
  mapRoot,
  anecdoteRoot,
  cardRoot,
  relicRoot,
  weaponRoot,
  backpackRoot
} from '../base.js'
import {
  fetchSelectorPage,
  fetchEntryPageById,
  selectorSignature,
  selectorSigMatches,
  hasUsableMeta,
  emitProgress
} from './crypto-api.js'
import { htmlToText, sanitizeRichHtml } from './text-volumes.js'

/** 单条目数据版本：解析规则变化时 +1，更新时会重拉这些频道 */
export const EXTRA_SCHEMA_VERSION = 1

/** 观测枢频道页：/ys/obc/channel/map/<mapId>/<channelId>（实测 mapId 用 1 也能打开） */
function channelPageUrl(channel) {
  return `https://baike.mihoyo.com/ys/obc/channel/map/${channel.mapId || 1}/${channel.id}?bbs_presentation_style=no_header&visit_device=pc`
}

/** 频道页 URL 的 map 段：就是该频道在 menus 里的 parent_id（图鉴类通常是 189） */
function mapIdFromPage(page, channelId) {
  const hit = (page?.menus || []).find(menu => String(menu?.id || '') === String(channelId))
  const parent = String(hit?.parent_id || '').trim()
  return parent || ''
}

function contentPageUrl(id) {
  return `https://baike.mihoyo.com/ys/obc/content/${id}/detail?bbs_presentation_style=no_header&visit_device=pc`
}

/** 扩展频道表（channel_id 见原神观测枢） */
export const EXTRA_CHANNELS = [
  { key: 'enemy', id: 6, name: '敌人', aliases: ['敌对物种', '怪物', '魔物'], mapId: 189 },
  { key: 'food', id: 21, name: '食物', aliases: ['料理', '食谱'], mapId: 1 },
  { key: 'domain', id: 54, name: '秘境', aliases: [], mapId: 1 },
  { key: 'npc', id: 20, name: 'NPC与商店', aliases: ['NPC', 'npc', '商店'], mapId: 1 },
  { key: 'achieve', id: 252, name: '成就', aliases: ['成就图鉴', '成绩'], mapId: 1 },
  { key: 'vista', id: 253, name: '观景点', aliases: ['观景'], mapId: 1 },
  { key: 'offering', id: 276, name: '地区供奉与聚所', aliases: ['供奉', '聚所'], mapId: 1 },
  { key: 'tutorial', id: 227, name: '教程', aliases: [], mapId: 1 },
  { key: 'nerven', id: 275, name: '幽境危战', aliases: ['危战'], mapId: 1, excludeModules: ['挑战说明', '战场信息'] },
  { key: 'gaze', id: 278, name: '灰眸', aliases: [], mapId: 189 }
]

/**
 * 老分类（已有专用解析器）：这里只做「模块级过滤」——
 * 页面按勾选裁掉未选模块，各类型自己的解析器照旧跑。
 * 默认全部勾选（保持现状），例外是剧情：任务概述/奖励/过程/地图说明等本来就不进正文，默认关。
 */
export const LEGACY_CHANNELS = [
  { key: 'book', id: 68, name: '书籍', legacy: true, root: booksRoot },
  { key: 'role', id: 25, name: '角色故事', legacy: true, root: storyRoot },
  { key: 'voice', id: 25, name: '角色语音', legacy: true, root: voiceRoot, hidden: true },
  { key: 'plot', id: 43, name: '剧情文本', legacy: true, root: plotRoot, defaultOffModules: ['任务概述', '任务奖励', '任务过程', '地图说明', '攻略方法', '攻略推荐'] },
  { key: 'map', id: 251, name: '地图文本', legacy: true, root: mapRoot },
  { key: 'anecdote', id: 261, name: '角色逸闻', legacy: true, root: anecdoteRoot },
  { key: 'card', id: 249, name: '月谕圣牌', legacy: true, root: cardRoot },
  { key: 'relic', id: 218, name: '圣遗物', legacy: true, root: relicRoot },
  { key: 'weapon', id: 5, name: '武器', legacy: true, root: weaponRoot },
  { key: 'backpack', id: 13, name: '背包', legacy: true, root: backpackRoot }
]

/** 配置与面板用的频道全集（老分类在前，id 冲突时老分类优先） */
export const ALL_CHANNELS = [...LEGACY_CHANNELS, ...EXTRA_CHANNELS]

const CHANNEL_CONFIG_FILE = path.join(cacheRoot, 'channels.json')
const MODULE_MANIFEST_FILE = path.join(cacheRoot, 'modules.json')

function extraRoot(key) {
  return path.join(dataRoot, 'extra', key)
}
function extraIndexFile(key) {
  return path.join(extraRoot(key), 'index.json')
}

export function extraChannelByKey(key) {
  return EXTRA_CHANNELS.find(item => item.key === String(key || '').trim()) || null
}

export function channelByKey(key) {
  return ALL_CHANNELS.find(item => item.key === String(key || '').trim()) || null
}

export function extraChannelByName(name) {
  const raw = String(name || '').trim()
  if (!raw) return null
  const matches = []
  for (const channel of EXTRA_CHANNELS) {
    for (const candidate of [channel.name, ...(channel.aliases || [])]) {
      if (candidate === raw) matches.push({ channel, len: candidate.length })
    }
  }
  return matches.sort((a, b) => b.len - a.len)[0]?.channel || null
}

/* ── 配置与清单 ───────────────────────────────────────────── */

function normalizePartMap(parts, manifestParts, current) {
  const out = {}
  for (const part of manifestParts || []) {
    out[part] = current?.[part] === undefined ? true : Boolean(current[part])
  }
  return out
}

/** 某个频道的默认勾选：新频道「只勾第一个模块」；excludeModules 的频道按排除表 */
function defaultModuleMap(channel, manifestModules) {
  const modules = {}
  const off = new Set([...(channel.excludeModules || []), ...(channel.defaultOffModules || [])])
  for (const [index, mod] of (manifestModules || []).entries()) {
    const key = mod.key || mod.name
    const isOff = off.has(mod.name) || off.has(key)
    const enabled = channel.legacy ? !isOff : (channel.excludeModules ? !isOff : index === 0)
    modules[key] = { enabled, name: mod.name || key, parts: normalizePartMap(null, mod.parts || []) }
  }
  return modules
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function loadModuleManifest() {
  return readJson(MODULE_MANIFEST_FILE, { channels: {} })
}

export async function loadChannelConfig() {
  const raw = await readJson(CHANNEL_CONFIG_FILE, { version: 1, channels: {} })
  return { version: 1, channels: raw?.channels || {} }
}

async function saveChannelConfig(config) {
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.writeFile(CHANNEL_CONFIG_FILE, JSON.stringify({ version: 1, channels: config.channels }, null, 2), 'utf8')
  return config
}

/** 合并「配置 + 清单」：补齐清单里新出现的模块/子项，保留用户已有勾选 */
export async function getChannelConfig() {
  const [config, manifest] = await Promise.all([loadChannelConfig(), loadModuleManifest()])
  const channels = {}
  for (const channel of ALL_CHANNELS) {
    const mods = manifest?.channels?.[channel.key]?.modules || []
    const current = config.channels[channel.key] || {}
    const modules = {}
    const defaults = defaultModuleMap(channel, mods)
    for (const mod of mods) {
      const key = mod.key || mod.name
      const cur = current.modules?.[key]
      const enabled = cur ? Boolean(cur.enabled) : Boolean(defaults[key]?.enabled)
      modules[key] = {
        enabled,
        name: cur?.name || mod.name || key,
        parts: normalizePartMap(null, mod.parts || [], cur?.parts)
      }
    }
    channels[channel.key] = {
      enabled: current.enabled === undefined ? true : Boolean(current.enabled),
      modules
    }
  }
  return { channels }
}

/** 保存 webui 传来的勾选（只接受已注册频道/模块/子项） */
export async function saveChannelConfigFromWeb(body) {
  const config = await loadChannelConfig()
  const next = { ...config, channels: { ...config.channels } }
  const incoming = body?.channels || {}
  for (const channel of ALL_CHANNELS) {
    const src = incoming[channel.key]
    if (!src) continue
    const modules = {}
    for (const [name, value] of Object.entries(src.modules || {})) {
      modules[String(name)] = {
        enabled: Boolean(value?.enabled),
        name: value?.name ? String(value.name) : undefined,
        parts: Object.fromEntries(Object.entries(value?.parts || {}).map(([k, v]) => [String(k), Boolean(v)]))
      }
    }
    next.channels[channel.key] = { enabled: Boolean(src.enabled), modules }
  }
  await saveChannelConfig(next)
  return getChannelConfig()
}

function configHash(entry) {
  const modules = Object.entries(entry?.modules || {})
    .map(([name, value]) => [name, Boolean(value.enabled), Object.entries(value.parts || {}).filter(([, v]) => v).map(([k]) => k).sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return createHash('md5').update(JSON.stringify({ enabled: Boolean(entry?.enabled), modules })).digest('hex').slice(0, 12)
}

/* ── 模块 → 富文本段 ──────────────────────────────────────── */

function parseComponentData(data) {
  if (typeof data !== 'string') return data
  const raw = data.trim()
  if (!raw) return ''
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/**
 * 模块键：按「模块名」定（不同条目里同名模块语义一致，勾选才有意义）；
 * 名字为空时才退化成「正文N·组件id」。
 * 注意：有些模块名就是条目名本身（敌人第一模块叫「千岩军士兵」），这类只在对应条目上匹配，
 * 未在清单里出现的模块名不会被过滤（未配置 = 保留）。
 */
function moduleKeyOf(mod, index) {
  const name = String(mod?.name || '').trim()
  if (name) return name
  const comps = (mod?.components || []).map(c => String(c?.component_id || c?.component_key || '?')).join('+') || 'unknown'
  return `正文${index + 1}·${comps}`
}

/** 模块显示名：没名字时用「正文N」 */
function moduleLabelOf(mod, index) {
  return String(mod?.name || '').trim() || `正文${index + 1}`
}

const IGNORE_KEYS = new Set(['layout_', 'repeated', 'switch', 'is_show_switch', 'moduleName', 'baseInfoSwitchDisabled', 'more_link'])
/** 只把「字段名」当子项标签；name/title 是内容（书名、卷名、技能名），不能当配置项 */
const LABEL_KEYS = ['key', 'tab_name', 'slot']
const VALUE_KEYS = ['value', 'text', 'rich_text', 'content', 'desc', 'story', 'html', 'img', 'icon_url', 'icon']

function labelOf(node) {
  for (const key of LABEL_KEYS) {
    const value = node?.[key]
    if (typeof value === 'string' && value.trim() && !IGNORE_KEYS.has(value.trim())) return value.trim()
  }
  return ''
}

function isImageUrl(text) {
  return /^https?:\/\/.+\.(?:png|jpe?g|gif|webp)(?:[?#]\S*)?$/i.test(String(text || '').trim())
}

/** 把一段 data 展开成富文本 html；parts 里显式为 false 的子项整段丢掉 */
function collectHtml(node, parts, out, seenImages) {
  if (node == null) return
  if (typeof node === 'string') {
    const raw = node.trim()
    if (!raw) return
    if (isImageUrl(raw)) {
      if (!seenImages.has(raw)) {
        seenImages.add(raw)
        out.push(`<img src="${raw}">`)
      }
      return
    }
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        collectHtml(JSON.parse(raw), parts, out, seenImages)
        return
      } catch { /* 当普通文本 */ }
    }
    const cleaned = sanitizeRichHtml(raw)
    if (cleaned.trim()) out.push(cleaned)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectHtml(item, parts, out, seenImages)
    return
  }
  if (typeof node !== 'object') return

  const label = labelOf(node)
  if (label && parts && parts[label] === false) return // 该子项没勾选：整段过滤

  if (label) out.push(`<p><strong>${label}</strong></p>`)
  let emitted = false
  for (const key of VALUE_KEYS) {
    if (node[key] === undefined) continue
    collectHtml(node[key], parts, out, seenImages)
    emitted = true
  }
  if (!emitted) {
    for (const [key, value] of Object.entries(node)) {
      if (IGNORE_KEYS.has(key) || LABEL_KEYS.includes(key)) continue
      collectHtml(value, parts, out, seenImages)
    }
  }
}

/** 按频道配置裁掉未勾选的模块（老分类用；默认全开时等价于原样返回） */
function filterPageModules(page, entry) {
  const modules = []
  for (const [index, mod] of (page?.modules || []).entries()) {
    const key = moduleKeyOf(mod, index)
    if (entry?.modules?.[key]?.enabled === false) continue
    modules.push(mod)
  }
  return { ...page, modules }
}

let configCache = { at: 0, value: null }
async function cachedChannelConfig() {
  if (configCache.value && Date.now() - configCache.at < 3000) return configCache.value
  const value = await getChannelConfig()
  configCache = { at: Date.now(), value }
  return value
}

/** 按页面自带 menus 里的频道 id 找到对应频道的勾选并过滤模块 */
export async function filterEntryPageByConfig(page) {
  const ids = new Set((page?.menus || []).map(menu => String(menu?.id || '')))
  if (!ids.size) return page
  try {
    const config = await cachedChannelConfig()
    for (const channel of ALL_CHANNELS) {
      if (!ids.has(String(channel.id))) continue
      const entry = config.channels[channel.key]
      if (!entry) continue
      return filterPageModules(page, entry)
    }
  } catch {
    /* 配置读不到就原样返回 */
  }
  return page
}

/** 抓详情并按勾选过滤模块（老分类的解析器统一改用它） */
export async function fetchEntryPageFilteredById(id) {
  const page = await fetchEntryPageById(id)
  return filterEntryPageByConfig(page)
}

/** 按配置把一页词条解析成 {richSections, sections} */
export function parseEntryPageByConfig(page, channelKey, entry) {
  const richSections = []
  const seenImages = new Set()
  for (const [index, mod] of (page?.modules || []).entries()) {
    const name = moduleKeyOf(mod, index)
    const label = moduleLabelOf(mod, index)
    const rule = entry?.modules?.[name]
    if (!rule?.enabled) continue
    const chunks = []
    for (const comp of mod.components || []) {
      collectHtml(parseComponentData(comp?.data), rule.parts || null, chunks, seenImages)
    }
    const html = chunks.join('\n').trim()
    if (!html) continue
    const text = htmlToText(html).replace(/\n{3,}/g, '\n\n').trim()
    if (!text && !/<img/i.test(html)) continue
    richSections.push({ title: label, html, text })
  }
  const sections = richSections.map(sec => ({ title: sec.title, text: sec.text }))
  const searchText = richSections.map(sec => `【${sec.title}】\n${sec.text || ''}`).join('\n\n').trim()
  return { richSections, sections, searchText }
}

/* ── 模块清单发现 ─────────────────────────────────────────── */

function collectParts(node, parts, depth = 0) {
  if (node == null || depth > 4) return
  if (Array.isArray(node)) {
    for (const item of node) collectParts(item, parts, depth)
    return
  }
  if (typeof node === 'string') {
    const raw = node.trim()
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        collectParts(JSON.parse(raw), parts, depth)
      } catch { /* 忽略 */ }
    }
    return
  }
  if (typeof node !== 'object') return
  const label = labelOf(node)
  if (label) parts.add(label)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parts' || IGNORE_KEYS.has(key)) continue
    collectParts(value, parts, depth + (LABEL_KEYS.includes(key) ? 0 : 1))
  }
}

/** 抽样若干条目，发现频道下所有模块名与子项名，写回清单并按默认策略补齐配置 */
export async function refreshChannelManifest(key, { samples = 1 } = {}) {
  const channel = channelByKey(key)
  if (!channel) throw new Error(`未注册的频道：${key}`)
  const list = (await fetchSelectorPage({ channelId: channel.id, page: 1, pageSize: samples, label: `${channel.name}模块清单` }))?.data?.list || []
  const modules = []
  const index = new Map()
  for (const item of list.slice(0, samples)) {
    const id = String(item.id || '').trim()
    if (!id) continue
    let page = null
    try {
      page = await fetchEntryPageById(id)
    } catch {
      continue
    }
    for (const [mIndex, mod] of (page?.modules || []).entries()) {
      const name = moduleKeyOf(mod, mIndex)
      const label = moduleLabelOf(mod, mIndex)
      let entry = index.get(name)
      if (!entry) {
        entry = { key: name, name: label, parts: [], images: 0 }
        index.set(name, entry)
        modules.push(entry)
      }
      const parts = new Set(entry.parts)
      let images = entry.images
      for (const comp of mod.components || []) {
        const data = parseComponentData(comp?.data)
        collectParts(data, parts)
        const html = []
        collectHtml(data, null, html, new Set())
        images += (html.join('').match(/<img/gi) || []).length
      }
      entry.parts = [...parts]
      entry.images = images
    }
  }

  let mapId = ''
  try {
    const first = list[0] ? await fetchEntryPageById(String(list[0].id)) : null
    mapId = mapIdFromPage(first, channel.id)
  } catch {
    mapId = ''
  }

  const manifest = await loadModuleManifest()
  manifest.channels = { ...(manifest.channels || {}), [key]: { sampledAt: Date.now(), legacy: Boolean(channel.legacy), mapId, sampleIds: list.slice(0, samples).map(i => String(i.id)), sampleNames: list.slice(0, samples).map(i => String(i.title || i.name || '')), modules } }
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.writeFile(MODULE_MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8')

  // 按默认策略补齐已有配置（新模块：默认频道「只勾第一个」/ 排除表频道按排除表）
  const config = await loadChannelConfig()
  const current = config.channels[key] || {}
  const defaults = defaultModuleMap(channel, modules)
  const merged = { enabled: current.enabled === undefined ? true : Boolean(current.enabled), modules: { ...defaults } }
  for (const [name, value] of Object.entries(current.modules || {})) {
    if (!merged.modules[name]) continue
    merged.modules[name] = {
      enabled: Boolean(value.enabled),
      name: value.name || merged.modules[name].name,
      parts: normalizePartMap(null, Object.keys(merged.modules[name].parts || {}), value.parts)
    }
  }
  config.channels[key] = merged
  await saveChannelConfig(config)
  return { channel, modules }
}

/* ── 拉取与存储 ───────────────────────────────────────────── */

function buildExtraFileName(name, id) {
  return `${slugify(name)}__${id}.json`
}

function normalizeKeyword(value) {
  return String(value || '').replace(/[「」『』“”"'’‘《》()（）\s]/g, '').toLowerCase()
}

async function cleanupOrphans(key, keepFiles) {
  const root = extraRoot(key)
  let files = []
  try {
    files = await fs.readdir(root)
  } catch {
    return 0
  }
  let removed = 0
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    if (file === 'index.json' || keepFiles.has(file)) continue
    try {
      await fs.unlink(path.join(root, file))
      removed += 1
    } catch { /* 忽略 */ }
  }
  return removed
}

/**
 * 抓取/更新一个扩展频道（按配置：未启用的频道直接跳过；配置指纹变化则重拉）
 */
export async function fetchExtraChannel(key, { onProgress, onError, deepCompare = false, dryRun = false } = {}) {
  const channel = extraChannelByKey(key)
  if (!channel) throw new Error(`未注册的扩展频道：${key}`)
  const config = await getChannelConfig()
  const entry = config.channels[key]
  if (!entry?.enabled) return { key, label: channel.name, total: 0, updated: 0, skipped: true }
  const cfgHash = configHash(entry)

  const root = extraRoot(key)
  await fs.mkdir(root, { recursive: true })
  const oldIndex = await readJson(extraIndexFile(key), { items: [] })
  const oldMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))

  const list = []
  for (let page = 1; page <= 100; page++) {
    const j = await fetchSelectorPage({ channelId: channel.id, page, pageSize: 100, label: `${channel.name}列表第 ${page} 页` })
    const items = j?.data?.list || []
    if (!items.length) break
    list.push(...items)
  }

  const total = list.length
  let done = 0
  let updated = 0
  let failed = 0
  let skipped = 0
  const items = []
  const keepFiles = new Set(['index.json'])

  for (const it of list) {
    const id = String(it.id || '').trim()
    if (!id) continue
    const name = String(it.title || it.name || '').trim() || `未命名-${id}`
    const fileName = buildExtraFileName(name, id)
    const file = path.join(root, fileName)
    const prev = oldMap.get(id)
    const prevFile = prev?.file ? path.join(root, prev.file) : ''
    const reusable = !deepCompare &&
      hasUsableMeta(prev, prevFile) &&
      Number(prev.extraSchemaVersion || 0) === EXTRA_SCHEMA_VERSION &&
      prev.cfgHash === cfgHash &&
      selectorSigMatches(prev.selectorSig, it)
    if (reusable) {
      if (prev.file !== fileName && prevFile && fss.existsSync(prevFile)) await fs.rename(prevFile, file)
      keepFiles.add(fileName)
      items.push({ ...prev, id, name, file: fileName, alias: [normalizeKeyword(name)], cfgHash, extraSchemaVersion: EXTRA_SCHEMA_VERSION })
      done += 1
      continue
    }
    try {
      const page = await fetchEntryPageById(id)
      if (!page) throw new Error(`未拿到词条详情（${id}）`)
      const parsed = parseEntryPageByConfig(page, key, entry)
      if (!parsed.richSections.length) {
        // 按当前勾选确实没内容：算跳过，不算失败（勾上别的模块就有）
        skipped += 1
        done += 1
        continue
      }
      if (!dryRun) {
        const data = {
          id,
          name,
          channel: key,
          channelName: channel.name,
          url: contentPageUrl(id),
          cfgHash,
          extraSchemaVersion: EXTRA_SCHEMA_VERSION,
          updatedAt: Date.now(),
          richSections: parsed.richSections,
          sections: parsed.sections,
          searchText: parsed.searchText
        }
        await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
      }
      keepFiles.add(fileName)
      items.push({ id, name, file: fileName, alias: [normalizeKeyword(name)], sectionCount: parsed.sections.length, selectorSig: selectorSignature(it), cfgHash, extraSchemaVersion: EXTRA_SCHEMA_VERSION })
      updated += 1
    } catch (error) {
      failed += 1
      await emitProgress(onError, { type: key, done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 25 === 0 || done === total)) await emitProgress(onProgress, { type: key, done, total })
  }

  items.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
  const removed = dryRun ? 0 : await cleanupOrphans(key, keepFiles)
  if (!dryRun) await fs.writeFile(extraIndexFile(key), JSON.stringify({ items, updatedAt: Date.now(), cfgHash }, null, 2), 'utf8')
  return { key, label: channel.name, total, updated, failed, skipped, removed }
}

/** 一次更新所有已启用的扩展频道 */
export async function fetchAllExtraChannels(reporter = {}) {
  const results = []
  for (const channel of EXTRA_CHANNELS) {
    try {
      results.push(await fetchExtraChannel(channel.key, reporter))
    } catch (error) {
      await emitProgress(reporter.onError, { type: channel.key, done: 1, total: 1, name: channel.name, error })
      results.push({ key: channel.key, label: channel.name, total: 0, updated: 0, failed: 1 })
    }
  }
  return results
}

/* ── 读取与检索 ───────────────────────────────────────────── */

export async function loadExtraIndex(key) {
  return readJson(extraIndexFile(key), { items: [] })
}

export async function loadExtraItem(key, id) {
  const index = await loadExtraIndex(key)
  const meta = (index.items || []).find(item => String(item.id) === String(id))
  if (!meta?.file) return null
  return readJson(path.join(extraRoot(key), meta.file), null)
}

export async function findExtraItemByName(key, keyword) {
  const index = await loadExtraIndex(key)
  const target = normalizeKeyword(keyword)
  if (!target) return null
  const exact = []
  const partial = []
  for (const item of index.items || []) {
    const name = normalizeKeyword(item.name)
    if (name === target) exact.push(item)
    else if (name.includes(target)) partial.push(item)
  }
  if (exact.length) return exact.length === 1 ? { item: exact[0] } : { ambiguous: exact.slice(0, 15) }
  partial.sort((a, b) => String(a.name).length - String(b.name).length)
  if (!partial.length) return null
  const shortest = String(partial[0].name).length
  const best = partial.filter(item => String(item.name).length === shortest)
  return best.length === 1 ? { item: best[0] } : { ambiguous: partial.slice(0, 15) }
}

export async function searchExtraIndex(key, keyword, limit = 30) {
  const index = await loadExtraIndex(key)
  const target = String(keyword || '').trim().toLowerCase()
  if (!target) return []
  const hits = []
  for (const item of index.items || []) {
    if (String(item.name).toLowerCase().includes(target)) hits.push(item)
    if (hits.length >= limit) break
  }
  return hits
}

/** 频道页链接（map 段优先用清单里探测到的 parent_id，其次注册表里的 mapId） */
export async function channelWikiUrl(key) {
  const channel = channelByKey(key)
  if (!channel) return ''
  const manifest = await loadModuleManifest()
  const mapId = manifest?.channels?.[key]?.mapId || channel.mapId || ''
  return `https://baike.mihoyo.com/ys/obc/channel/map/${mapId || 1}/${channel.id}?bbs_presentation_style=no_header&visit_device=pc`
}

/** 只读的频道总览（给 webui 与帮助用） */
export async function extraChannelStatus() {
  const [config, manifest] = await Promise.all([getChannelConfig(), loadModuleManifest()])
  const out = []
  for (const channel of ALL_CHANNELS) {
    let itemCount = 0
    if (channel.legacy) {
      try {
        itemCount = (await fs.readdir(channel.root)).filter(file => file.endsWith('.json') && file !== 'index.json' && !file.startsWith('_')).length
        if (channel.key === 'book') {
          itemCount = (await fs.readdir(channel.root)).filter(file => file.endsWith('.txt')).length
        }
      } catch {
        itemCount = 0
      }
    } else {
      itemCount = ((await loadExtraIndex(channel.key)).items || []).length
    }
    out.push({
      key: channel.key,
      id: channel.id,
      name: channel.name,
      legacy: Boolean(channel.legacy),
      hidden: Boolean(channel.hidden),
      aliases: channel.aliases || [],
      wikiUrl: await channelWikiUrl(channel.key),
      enabled: Boolean(config.channels[channel.key]?.enabled),
      itemCount,
      modules: manifest?.channels?.[channel.key]?.modules || [],
      sampleNames: manifest?.channels?.[channel.key]?.sampleNames || [],
      sampleIds: manifest?.channels?.[channel.key]?.sampleIds || [],
      config: config.channels[channel.key] || null
    })
  }
  return out
}
