import { cleanPlotText, htmlToText, sanitizeRichHtml } from './text-volumes.js'
import { parseInteractiveDialogue, parseInteractiveDialogueRich } from './parse-interactive.js'

function parsePlotCategory(extRaw = '') {
  try {
    const ext = typeof extRaw === 'string' ? JSON.parse(extRaw || '{}') : (extRaw || {})
    const text = ext?.c_43?.filter?.text || ''
    const arr = typeof text === 'string' ? JSON.parse(text) : []
    const hit = arr.find(x => String(x).startsWith('任务类型/'))
    return hit ? String(hit).replace(/^任务类型\//, '').trim() : '其他任务'
  } catch {
    return '其他任务'
  }
}

function extractPlotSubtitle(page = {}) {
  const modules = page.modules || []
  const titles = []
  for (const m of modules) {
    const hasBase = (m.components || []).some(c => (c.component_id || '') === 'base_info')
    if (!hasBase) continue
    const name = String(m.name || '').trim()
    if (!name) continue
    titles.push(name)
  }
  const uniq = [...new Set(titles)]
  return uniq.join(' / ')
}

function collectPlotStrings(value, out = []) {
  if (value == null) return out
  if (Array.isArray(value)) {
    for (const v of value) collectPlotStrings(v, out)
    return out
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectPlotStrings(v, out)
    return out
  }
  if (typeof value !== 'string') return out

  const raw = value.trim()
  if (!raw || /^https?:\/\//i.test(raw)) return out

  const txt = cleanPlotText(htmlToText(raw))
  if (!txt || txt.length < 2) return out
  if (/^[\d\s.,:;_\-\/]+$/.test(txt)) return out

  out.push(txt)
  return out
}

function collectPlotRichStrings(value, out = []) {
  if (value == null) return out
  if (Array.isArray(value)) {
    for (const v of value) collectPlotRichStrings(v, out)
    return out
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectPlotRichStrings(v, out)
    return out
  }
  if (typeof value !== 'string') return out

  const raw = value.trim()
  if (!raw) return out
  // 图片 URL 按原位置保留成 <img>，供正文内联（对齐星铁）
  if (/^https?:\/\//i.test(raw)) {
    if (/\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i.test(raw)) out.push(`<img src="${raw}">`)
    return out
  }

  const rich = sanitizeRichHtml(raw)
  const txt = cleanPlotText(htmlToText(rich))
  if (!txt || txt.length < 2) return out
  if (/^[\d\s.,:;_\-\/]+$/.test(txt)) return out

  out.push(rich)
  return out
}

function parseGenericPlotComponent(comp = {}) {
  let data = {}
  try { data = JSON.parse(comp.data || '{}') } catch { return '' }
  const lines = collectPlotStrings(data, [])
  return cleanPlotText(lines.join('\n'))
}

function parseGenericPlotComponentRich(comp = {}) {
  let data = {}
  try { data = JSON.parse(comp.data || '{}') } catch { return '' }
  const lines = collectPlotRichStrings(data, [])
  return lines.join('\n')
}

function parsePlotPageBase(page = {}, rich = false) {
  const modules = page.modules || []
  const sections = []
  const add = (title, txt) => {
    const t = rich ? cleanPlotText(htmlToText(txt || '')) : cleanPlotText(txt || '')
    if (!t || t.length < 2) return
    sections.push(rich ? { title, html: txt, text: t } : { title, text: t })
  }

  const parseModuleDialogue = (m = {}) => {
    const comps = m.components || []
    const collected = []
    for (const comp of comps) {
      const cid = comp.component_id || ''
      if (cid === 'interactive_dialogue') {
        const txt = rich ? parseInteractiveDialogueRich(comp) : parseInteractiveDialogue(comp)
        if (txt) collected.push(txt)
        continue
      }
      const txt = rich ? parseGenericPlotComponentRich(comp) : parseGenericPlotComponent(comp)
      if (txt) collected.push(txt)
    }
    return rich ? collected.filter(Boolean).join('\n') : cleanPlotText(collected.filter(Boolean).join('\n\n'))
  }

  let dialogueIndex = 0
  for (const m of modules) {
    const name = (m.name || '').trim()
    const cids = (m.components || []).map(c => c.component_id || '')
    const hasInteractive = cids.includes('interactive_dialogue')
    const isPlotNamed = name === '剧情对话' || /^剧情对话/.test(name)

    if (!isPlotNamed && !hasInteractive) continue

    const merged = parseModuleDialogue(m)
    if (!merged) continue

    dialogueIndex += 1
    const title = name && name !== '剧情对话' && !/^剧情对话\s*\d+$/.test(name)
      ? `剧情对话 ${dialogueIndex}（${name}）`
      : `剧情对话 ${dialogueIndex}`
    add(title, merged)
  }

  if (!sections.length) {
    let processIndex = 0
    for (const m of modules) {
      const name = (m.name || '').trim()
      if (!['任务过程', '任务概述'].includes(name)) continue
      const txt = parseModuleDialogue(m)
      if (!txt || txt.length < 6) continue
      processIndex += 1
      const title = name === '任务过程' ? `任务过程 ${processIndex}` : name
      add(title, txt)
    }
  }

  // 富文本模式额外收图：剧情页的图片基本都在「任务概述 / 任务奖励 / 地图说明」这些正文之外的模块里，
  // 这里按原顺序把它们收成一段「任务图片」，正文发送时内联展示（对齐星铁）
  if (rich) {
    const usedImages = new Set()
    for (const sec of sections) {
      for (const m of String(sec.html || '').matchAll(/<img[^>]*src=["']([^"']+)["']/gi)) usedImages.add(m[1])
    }
    const extra = []
    const pushImage = url => {
      const u = String(url || '').trim()
      if (!u || usedImages.has(u)) return
      usedImages.add(u)
      extra.push(u)
    }
    const scan = node => {
      if (node == null) return
      if (typeof node === 'string') {
        const raw = node.trim()
        // 组件的 data 常常是一段 JSON 字符串，先解开再扫
        if (raw.startsWith('{') || raw.startsWith('[')) {
          try { scan(JSON.parse(raw)); return } catch { /* 不是 JSON 就当普通文本 */ }
        }
        if (/^https?:\/\/.+\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i.test(raw)) { pushImage(raw); return }
        for (const m of raw.replace(/\\"/g, '"').matchAll(/<img[^>]*src=["']([^"']+)["']/gi)) pushImage(m[1])
        return
      }
      if (Array.isArray(node)) { for (const v of node) scan(v); return }
      if (typeof node === 'object') { for (const v of Object.values(node)) scan(v) }
    }
    for (const m of modules) {
      const name = (m.name || '').trim()
      if (name === '剧情对话' || /^剧情对话/.test(name)) continue
      scan(m)
      if (extra.length >= 40) break
    }
    if (extra.length) {
      sections.push({
        title: '任务图片',
        html: extra.map(u => `<img src="${u}">`).join(''),
        text: `任务图片 ${extra.length} 张（来自任务概述/任务奖励/地图说明）`
      })
    }
  }

  const dedup = []
  const seen = new Set()
  for (const sec of sections) {
    const key = sec.text
    if (!key || seen.has(key)) continue
    seen.add(key)
    dedup.push(sec)
  }
  return dedup
}

function parsePlotPage(page = {}) {
  return parsePlotPageBase(page, false)
}

function parsePlotPageRich(page = {}) {
  return parsePlotPageBase(page, true)
}

function parsePlotSearchText(page = {}) {
  const sections = parsePlotPage(page)
  return sections.map(sec => `【${sec.title}】\n${sec.text}`).join('\n\n').trim()
}

function renderPlotText(item, mode = 'full') {
  const lines = []
  if (mode === 'detail') {
    lines.push(`📜 ${item.name}剧情详情`)
    if (item.subtitle) lines.push(`副标题：${item.subtitle}`)
    lines.push(`任务类型：${item.category || '其他任务'}`)
    lines.push(`剧情段数：${(item.sections || []).length}`)
    ;(item.sections || []).forEach((sec, i) => lines.push(`${i + 1}. ${sec.title || `剧情段落 ${i + 1}`}`))
    return lines.join('\n')
  }

  lines.push(`📜 ${item.name}剧情文本`)
  if (item.subtitle) lines.push(`副标题：${item.subtitle}`)
  if (item.category) lines.push(`任务类型：${item.category}`)
  ;(item.sections || []).forEach((sec, i) => {
    lines.push(`\n【${sec.title || `剧情段落 ${i + 1}`}】\n${sec.text || ''}`)
  })
  return lines.join('\n')
}

export {
  parsePlotCategory,
  extractPlotSubtitle,
  collectPlotStrings,
  collectPlotRichStrings,
  parseGenericPlotComponent,
  parseGenericPlotComponentRich,
  parsePlotPage,
  parsePlotPageRich,
  parsePlotSearchText,
  renderPlotText
}
