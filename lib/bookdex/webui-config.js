import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { cacheRoot } from './base.js'

const webConfigFile = path.join(cacheRoot, 'webui.json')
const DEFAULT_PORT = 14522
const DEFAULT_HOST = '0.0.0.0'
const FORCE_MODULE_KEYS = ['book', 'map']

function normalizeForceModules(value) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(values.map(item => String(item || '').trim()))]
    .filter(key => FORCE_MODULE_KEYS.includes(key))
}

function defaultConfig() {
  return {
    webui: {
      enabled: true,
      host: DEFAULT_HOST,
      publicHost: '',
      port: DEFAULT_PORT,
      token: randomBytes(18).toString('base64url')
    },
    autoUpdate: {
      enabled: true,
      nextRunAt: '',
      forceModules: []
    }
  }
}

function mergeConfig(raw = {}) {
  const def = defaultConfig()
  return {
    webui: {
      ...def.webui,
      ...(raw.webui || {}),
      token: raw?.webui?.token || def.webui.token
    },
    autoUpdate: {
      ...def.autoUpdate,
      ...(raw.autoUpdate || {}),
      forceModules: normalizeForceModules(raw?.autoUpdate?.forceModules)
    }
  }
}

async function loadBookDexWebConfig() {
  try {
    const parsed = JSON.parse(await fs.readFile(webConfigFile, 'utf8'))
    return mergeConfig(parsed)
  } catch {
    const cfg = defaultConfig()
    await saveBookDexWebConfig(cfg)
    return cfg
  }
}

function loadBookDexWebConfigSync() {
  try {
    const parsed = JSON.parse(fss.readFileSync(webConfigFile, 'utf8'))
    return mergeConfig(parsed)
  } catch {
    const cfg = defaultConfig()
    try {
      fss.mkdirSync(cacheRoot, { recursive: true })
      fss.writeFileSync(webConfigFile, JSON.stringify(cfg, null, 2), 'utf8')
    } catch {}
    return cfg
  }
}

async function saveBookDexWebConfig(config = {}) {
  const cfg = mergeConfig(config)
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.writeFile(webConfigFile, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

function getDefaultAutoUpdateInfo(now = Date.now()) {
  const gmt8Now = new Date(now + 8 * 3600 * 1000)
  const nextRunAt = Date.UTC(
    gmt8Now.getUTCFullYear(),
    gmt8Now.getUTCMonth(),
    gmt8Now.getUTCDate() + 1
  ) - 8 * 3600 * 1000
  return { nextRunAt, nextRunAtText: formatGmt8(nextRunAt) }
}

function formatGmt8(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms) + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function parseDateTimeToMs(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  const normalized = text.includes('T') ? text : text.replace(' ', 'T')
  const ms = Date.parse(`${normalized}${/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? '' : '+08:00'}`)
  return Number.isFinite(ms) ? ms : 0
}

function getConfiguredNextAutoRun(config = loadBookDexWebConfigSync(), now = Date.now()) {
  if (!config.autoUpdate?.enabled) return { enabled: false, nextRunAt: 0, nextRunAtText: '已关闭', custom: false }
  const customMs = parseDateTimeToMs(config.autoUpdate?.nextRunAt)
  if (customMs) return { enabled: true, nextRunAt: customMs, nextRunAtText: formatGmt8(customMs), custom: true }
  return { enabled: true, ...getDefaultAutoUpdateInfo(now), custom: false }
}

function shouldRunBookDexAutoUpdate(now = Date.now()) {
  const cfg = loadBookDexWebConfigSync()
  if (!cfg.autoUpdate?.enabled) return false
  const customMs = parseDateTimeToMs(cfg.autoUpdate?.nextRunAt)
  if (customMs) return now >= customMs
  return true
}

async function consumeCustomAutoRun() {
  const cfg = await loadBookDexWebConfig()
  if (!cfg.autoUpdate?.nextRunAt) return cfg
  cfg.autoUpdate.nextRunAt = ''
  return saveBookDexWebConfig(cfg)
}

export {
  webConfigFile,
  loadBookDexWebConfig,
  loadBookDexWebConfigSync,
  saveBookDexWebConfig,
  getDefaultAutoUpdateInfo,
  getConfiguredNextAutoRun,
  shouldRunBookDexAutoUpdate,
  consumeCustomAutoRun,
  formatGmt8,
  parseDateTimeToMs,
  FORCE_MODULE_KEYS,
  normalizeForceModules
}
