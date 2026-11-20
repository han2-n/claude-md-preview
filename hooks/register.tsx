import { atom, read, update } from 'claude-code'
import type { ElementTable, Hook, Register, RenderChildren } from 'claude-code'

import type { TableStyle } from '../types'

type Dollar = Parameters<Hook<'session.start'>>[0]

const PANE = 'md-preview'
const TITLE = 'MD Preview'
/** Ô rộng hơn chừng này cột thì xuống dòng trong ô. */
const MAX_COL = 40
const MAX_LIST = 80
/** Một lần vẽ chỉ chở được chừng ấy ký tự; tài liệu dài hơn bị cắt, kèm ghi chú. */
const MAX_TEXT = 90_000
const POLL_MS = 4000

const openPath = atom({ plugin: 'md-preview', key: 'openPath' } as const, null)
const query = atom({ plugin: 'md-preview', key: 'query' } as const, '')
const tableStyle = atom({ plugin: 'md-preview', key: 'tableStyle' } as const, 'grid')
const chatText = atom({ plugin: 'md-preview', key: 'chatText' } as const, '')
const isChatGrid = atom({ plugin: 'md-preview', key: 'isChatGrid' } as const, true)
/** Cột đang sắp xếp của từng bảng trong pane, khoá `<đường dẫn>#<số bảng>`. */
const sorts = atom({ plugin: 'md-preview', key: 'sorts' } as const, {})
/** Tăng mỗi lần index.tsv hay seen.tsv đổi, để danh sách (đọc nó khi vẽ) vẽ lại. */
const listTick = atom({ plugin: 'md-preview', key: 'listTick' } as const, 0)

/** `openPath` mang dấu này khi pane đang xem bảng của một câu trả lời, không phải file. */
const CHAT = '::chat::'

// ---------- Danh sách tài liệu ~/.md-preview/index.tsv (mod tự ghi) ----------

type Doc = { source: string; updated: number; tables: number; root: string }

async function storeDir($: Dollar): Promise<string | undefined> {
  const profile = await $.env.get('USERPROFILE')
  const home = profile ?? (await $.env.get('HOME'))
  return home === undefined ? undefined : `${home}\\.md-preview`
}

function parseIndex(text: string): Doc[] {
  const docs: Doc[] = []
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts.length < 6) continue
    docs.push({
      source: parts[1] ?? '',
      updated: Number(parts[3]) || 0,
      tables: Number(parts[4]) || 0,
      root: parts[5] ?? '',
    })
  }
  return docs.sort((a, b) => b.updated - a.updated)
}

async function loadDocs($: Dollar): Promise<Doc[]> {
  const dir = await storeDir($)
  if (dir === undefined) return []
  const text = await $.fs.read(`${dir}\\index.tsv`).catch(() => '')
  return parseIndex(text)
}

/** FNV-1a 32-bit: khoá ổn định cho một đường dẫn (cột đầu của index.tsv). */
function pathKey(path: string): string {
  let hash = 0x811c9dc5
  for (const ch of path.replace(/\//g, '\\').toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Thêm hoặc cập nhật một tài liệu trong index.tsv; cột thứ ba để trống (trước là bản sao). */
async function recordDoc($: Dollar, source: string, root: string, tables: number): Promise<void> {
  const dir = await storeDir($)
  if (dir === undefined) return
  const indexPath = `${dir}\\index.tsv`
  const old = await $.fs.read(indexPath).catch(() => '')
  const key = pathKey(source)
  const lower = source.toLowerCase()
  const kept = old
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && line.split('\t')[1]?.toLowerCase() !== lower)
  const nowSec = Math.floor((await $.clock.now()) / 1000)
  const line = [key, source, '', String(nowSec), String(tables), root].join('\t')
  const text = [...kept, line].join('\n') + '\n'
  await $.fs.write(indexPath, text)
  await update($, listTick, n => n + 1)
}

// ---------- Đã xem: ~/.md-preview/seen.tsv ----------
// Dòng đầu `#since<TAB>giây`: tài liệu cũ hơn mốc này coi như đã xem (để danh sách cũ không chấm hết).
// Mỗi dòng sau: `đường dẫn viết thường<TAB>giây lần cuối mở xem`.

type Seen = { since: number; at: Map<string, number> }

async function loadSeen($: Dollar): Promise<Seen> {
  const dir = await storeDir($)
  const text = dir === undefined ? '' : await $.fs.read(`${dir}\\seen.tsv`).catch(() => '')
  const seen: Seen = { since: 0, at: new Map() }
  for (const line of text.split(/\r?\n/)) {
    const [key, value] = line.split('\t')
    if (key === undefined || value === undefined) continue
    if (key === '#since') seen.since = Number(value) || 0
    else seen.at.set(key, Number(value) || 0)
  }
  return seen
}

async function saveSeen($: Dollar, seen: Seen): Promise<void> {
  const dir = await storeDir($)
  if (dir === undefined) return
  const lines = [`#since\t${seen.since}`, ...[...seen.at].map(([k, v]) => `${k}\t${v}`)]
  await $.fs.write(`${dir}\\seen.tsv`, lines.join('\n') + '\n')
  // Danh sách đọc biến đếm này khi vẽ: tăng nó là danh sách vẽ lại.
  await update($, listTick, n => n + 1)
}

/** Ghi mốc "đã xem" lần đầu chạy, để chỉ những tài liệu sửa sau đó mới hiện chấm. */
async function ensureSeen($: Dollar): Promise<void> {
  const seen = await loadSeen($)
  if (seen.since > 0) return
  seen.since = Math.floor((await $.clock.now()) / 1000)
  await saveSeen($, seen)
}

async function markSeen($: Dollar, path: string): Promise<void> {
  const seen = await loadSeen($)
  seen.at.set(path.toLowerCase(), Math.floor((await $.clock.now()) / 1000))
  await saveSeen($, seen)
}

async function markAllSeen($: Dollar): Promise<void> {
  const nowSec = Math.floor((await $.clock.now()) / 1000)
  await saveSeen($, { since: nowSec, at: new Map() })
}

function isUnread(doc: Doc, seen: Seen): boolean {
  const viewedAt = seen.at.get(doc.source.toLowerCase()) ?? seen.since
  return doc.updated > viewedAt
}

/** Mở một tài liệu trong pane và đánh dấu đã xem. */
async function openDoc($: Dollar, path: string): Promise<void> {
  await update($, openPath, () => path)
  await markSeen($, path)
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function projectName(doc: Doc): string {
  return baseName(doc.root.replace(/[\\/]+$/, ''))
}

/** Thư mục chứa file, tính từ gốc dự án. */
function folderInProject(doc: Doc): string {
  // Claude có khi viết `D:/a/b`, có khi `D:\a\b`: so sánh sau khi đưa về cùng một kiểu.
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  const root = doc.root.replace(/[\\/]+$/, '')
  const isInside = norm(doc.source).startsWith(norm(root) + '\\')
  const rel = isInside ? doc.source.slice(root.length + 1) : doc.source
  const cut = Math.max(rel.lastIndexOf('\\'), rel.lastIndexOf('/'))
  return cut < 0 ? '' : rel.slice(0, cut)
}

function relativeTime(nowMs: number, updatedSec: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - updatedSec)
  if (diff < 60) return 'vừa xong'
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`
  if (diff < 86_400) return `${Math.floor(diff / 3600)} giờ trước`
  return `${Math.floor(diff / 86_400)} ngày trước`
}

// ---------- Tách Markdown thành đoạn chữ và bảng ----------

type Align = 'left' | 'right' | 'center'
/** Một đoạn chữ trong ô, kèm định dạng inline của nó. */
type Span = { text: string; bold?: true; code?: true; strike?: true; link?: string }
/** Một ô: Markdown gốc (để vẽ lại kiểu Claude), chữ trơn (để đo và sắp xếp), các đoạn có định dạng. */
type Cell = { raw: string; plain: string; spans: Span[] }
type Table = { header: Cell[]; aligns: Align[]; rows: Cell[][] }
type Segment = { kind: 'text'; text: string } | { kind: 'table'; table: Table }

const FENCE = /^\s*(```|~~~)/
const EMPTY_CELL: Cell = { raw: '', plain: '', spans: [] }

function isSeparator(line: string): boolean {
  const t = line.trim()
  return t.includes('-') && t.includes('|') && /^[\s|:-]+$/.test(t)
}

/** Tách một dòng bảng theo `|`, bỏ qua `\|` và `|` nằm trong `code`. */
function splitRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '\\' && t[i + 1] === '|') {
      cell += '|'
      i++
      continue
    }
    if (ch === '`') inCode = !inCode
    if (ch === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell.trim())
  return cells
}

function alignOf(spec: string): Align {
  const s = spec.trim()
  if (s.startsWith(':') && s.endsWith(':')) return 'center'
  if (s.endsWith(':')) return 'right'
  return 'left'
}

/** `code`, **đậm**, __đậm__, ~~gạch~~, [chữ](link); phần còn lại là chữ thường. */
const INLINE = /`([^`]*)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g

function parseCell(raw: string): Cell {
  const source = raw.replace(/<br\s*\/?>/gi, ' ')
  const spans: Span[] = []
  let last = 0
  for (const m of source.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) spans.push({ text: source.slice(last, at) })
    if (m[1] !== undefined) spans.push({ text: m[1], code: true })
    else if (m[2] !== undefined) spans.push({ text: m[2], bold: true })
    else if (m[3] !== undefined) spans.push({ text: m[3], bold: true })
    else if (m[4] !== undefined) spans.push({ text: m[4], strike: true })
    else spans.push({ text: m[5] ?? '', link: m[6] ?? '' })
    last = at + m[0].length
  }
  if (last < source.length) spans.push({ text: source.slice(last) })
  const plain = spans.map(s => s.text).join('')
  return { raw, plain, spans }
}

function splitSegments(text: string): Segment[] {
  const lines = text.split(/\r?\n/)
  const segments: Segment[] = []
  let buf: string[] = []
  let inFence = false
  const flush = () => {
    const chunk = buf.join('\n')
    if (chunk.trim() !== '') segments.push({ kind: 'text', text: chunk })
    buf = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) inFence = !inFence
    const next = lines[i + 1] ?? ''
    const startsTable = !inFence && line.includes('|') && isSeparator(next)
    if (!startsTable) {
      buf.push(line)
      continue
    }
    flush()
    const header = splitRow(line).map(parseCell)
    const aligns = splitRow(next).map(alignOf)
    const rows: Cell[][] = []
    let j = i + 2
    while (j < lines.length) {
      const rowLine = lines[j] ?? ''
      if (!rowLine.includes('|') || rowLine.trim() === '') break
      const cells = splitRow(rowLine).map(parseCell)
      rows.push(cells)
      j++
    }
    segments.push({ kind: 'table', table: { header, aligns, rows } })
    i = j - 1
  }
  flush()
  return segments
}

// ---------- Sắp xếp dòng theo một cột ----------

type Sort = { col: number; isDesc: boolean }

const MULTIPLIER: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 }

/** Đọc ô như một con số: "5 516", "1,263", "39.7k", "12%"; không phải số thì undefined. */
function numericValue(text: string): number | undefined {
  const t = text.replace(/[\s  ]/g, '')
  const m = /^([-+]?\d[\d.,]*)([kKmMbB%]?)$/.exec(t)
  if (m === null) return undefined
  let digits = m[1] ?? ''
  const suffix = (m[2] ?? '').toLowerCase()
  const isGrouped = /^[-+]?\d{1,3}([.,]\d{3})+$/.test(digits)
  if (isGrouped && suffix === '') digits = digits.replace(/[.,]/g, '')
  else digits = digits.replace(',', '.')
  const value = Number(digits)
  if (Number.isNaN(value)) return undefined
  return value * (MULTIPLIER[suffix] ?? 1)
}

function compareCells(a: string, b: string): number {
  const isEmptyA = a.trim() === ''
  const isEmptyB = b.trim() === ''
  if (isEmptyA || isEmptyB) return isEmptyA === isEmptyB ? 0 : isEmptyA ? 1 : -1
  const na = numericValue(a)
  const nb = numericValue(b)
  if (na !== undefined && nb !== undefined) return na - nb
  if (na !== undefined) return -1
  if (nb !== undefined) return 1
  return a.localeCompare(b, 'vi', { numeric: true, sensitivity: 'base' })
}

function sortTable(table: Table, sort: Sort | undefined): Table {
  if (sort === undefined) return table
  const sign = sort.isDesc ? -1 : 1
  const key = (row: Cell[]) => row[sort.col]?.plain ?? ''
  const rows = [...table.rows].sort((a, b) => sign * compareCells(key(a), key(b)))
  return { ...table, rows }
}

/** Bấm một cột: chưa sắp → tăng dần → giảm dần → bỏ sắp xếp. */
function nextSort(current: Sort | undefined, col: number): Sort | undefined {
  if (current === undefined || current.col !== col) return { col, isDesc: false }
  if (!current.isDesc) return { col, isDesc: true }
  return undefined
}

// ---------- Vẽ bảng thành các dòng chữ cùng độ rộng ----------

function charWidth(code: number): number {
  if (code >= 0x300 && code <= 0x36f) return 0
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  return isWide ? 2 : 1
}

function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** Một mẩu chữ trên một dòng của lưới; `style` là định dạng nó mang theo từ ô. */
type Run = { text: string; style?: Span }
type Word = Run[]

function runsWidth(runs: Run[]): number {
  return runs.reduce((w, r) => w + textWidth(r.text), 0)
}

/** Tách các đoạn của ô thành từ; một từ có thể gồm nhiều mẩu khác định dạng (vd. **a**b). */
function cellWords(spans: Span[]): Word[] {
  const words: Word[] = []
  let word: Word = []
  for (const span of spans) {
    const style = span.bold || span.code || span.strike || span.link !== undefined ? span : undefined
    for (const piece of span.text.split(/(\s+)/)) {
      if (piece === '') continue
      if (/^\s+$/.test(piece)) {
        if (word.length > 0) words.push(word)
        word = []
        continue
      }
      word.push({ text: piece, style })
    }
  }
  if (word.length > 0) words.push(word)
  return words
}

/** Bẻ dòng theo từ; từ nào dài hơn ô thì cắt theo ký tự. */
function wrapRuns(spans: Span[], width: number): Run[][] {
  const lines: Run[][] = []
  let line: Run[] = []
  let lineW = 0
  const push = (run: Run) => {
    const prev = line[line.length - 1]
    if (prev !== undefined && prev.style === run.style) prev.text += run.text
    else line.push({ ...run })
  }

  for (const word of cellWords(spans)) {
    const wordW = runsWidth(word)
    const needed = line.length === 0 ? wordW : lineW + 1 + wordW
    if (needed <= width) {
      if (line.length > 0) push({ text: ' ' })
      word.forEach(push)
      lineW = needed
      continue
    }
    if (line.length > 0) {
      lines.push(line)
      line = []
      lineW = 0
    }
    if (wordW <= width) {
      word.forEach(push)
      lineW = wordW
      continue
    }
    for (const run of word) {
      for (const ch of run.text) {
        const chW = charWidth(ch.codePointAt(0) ?? 0)
        if (lineW + chW > width && line.length > 0) {
          lines.push(line)
          line = []
          lineW = 0
        }
        push({ text: ch, style: run.style })
        lineW += chW
      }
    }
  }
  if (line.length > 0 || lines.length === 0) lines.push(line)
  return lines
}

function padRuns(runs: Run[], width: number, align: Align): Run[] {
  const gap = Math.max(0, width - runsWidth(runs))
  if (gap === 0) return runs
  if (align === 'right') return [{ text: ' '.repeat(gap) }, ...runs]
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return [{ text: ' '.repeat(left) }, ...runs, { text: ' '.repeat(gap - left) }]
  }
  return [...runs, { text: ' '.repeat(gap) }]
}

/** Một dòng màn hình của lưới. `isStriped`: dòng dữ liệu thứ chẵn, tô nền nhạt. */
type GridLine = { runs: Run[]; isHeader: boolean; isStriped: boolean }

function gridLines(table: Table): GridLine[] {
  const ncols = Math.max(table.header.length, ...table.rows.map(r => r.length))
  const all = [table.header, ...table.rows]
  const widths: number[] = []
  for (let c = 0; c < ncols; c++) {
    const natural = Math.max(1, ...all.map(r => textWidth(r[c]?.plain ?? '')))
    widths.push(Math.min(natural, MAX_COL))
  }
  const aligns = Array.from({ length: ncols }, (_, c) => table.aligns[c] ?? 'left')
  const border = (l: string, m: string, r: string, fill: string): GridLine => ({
    runs: [{ text: l + widths.map(w => fill.repeat(w + 2)).join(m) + r }],
    isHeader: false,
    isStriped: false,
  })

  const rowLines = (row: Cell[], isHeader: boolean, isStriped: boolean): GridLine[] => {
    const cells = widths.map((w, c) => wrapRuns((row[c] ?? EMPTY_CELL).spans, w))
    const height = Math.max(...cells.map(c => c.length))
    const out: GridLine[] = []
    for (let k = 0; k < height; k++) {
      const runs: Run[] = [{ text: '│ ' }]
      cells.forEach((lines, c) => {
        if (c > 0) runs.push({ text: ' │ ' })
        runs.push(...padRuns(lines[k] ?? [], widths[c] ?? 1, aligns[c] ?? 'left'))
      })
      runs.push({ text: ' │' })
      out.push({ runs, isHeader, isStriped })
    }
    return out
  }

  const anyWrapped = table.rows.some(r => r.some((cell, c) => textWidth(cell.plain) > (widths[c] ?? 0)))
  const lines: GridLine[] = [border('┌', '┬', '┐', '─')]
  lines.push(...rowLines(table.header, true, false))
  lines.push(border('╞', '╪', '╡', '═'))
  table.rows.forEach((row, i) => {
    if (anyWrapped && i > 0) lines.push(border('├', '┼', '┤', '─'))
    lines.push(...rowLines(row, false, i % 2 === 1))
  })
  lines.push(border('└', '┴', '┘', '─'))
  return lines
}

/** Chữ thuần của một dòng lưới (để đo, để test tìm). */
function lineText(line: GridLine): string {
  return line.runs.map(r => r.text).join('')
}

/** Các link trong bảng, để liệt kê bấm được dưới lưới (trong lưới chữ đơn cách không bấm được). */
function tableLinks(table: Table): string {
  const seen = new Set<string>()
  const links: string[] = []
  for (const cell of [...table.header, ...table.rows.flat()]) {
    for (const span of cell.spans) {
      if (span.link === undefined || span.link === '' || seen.has(span.link)) continue
      seen.add(span.link)
      const label = span.text.replace(/[[\]]/g, '') || span.link
      links.push(`[${label}](${span.link})`)
    }
  }
  return links.join(' · ')
}

/** Bảng dưới dạng Markdown gốc, để vẽ kiểu câu trả lời của Claude. */
function tableMarkdown(table: Table): string {
  const esc = (cell: Cell) => cell.raw.replace(/\|/g, '\\|')
  const sep = table.header.map((_, c) => {
    const a = table.aligns[c] ?? 'left'
    if (a === 'center') return ':---:'
    if (a === 'right') return '---:'
    return '---'
  })
  const head = `| ${table.header.map(esc).join(' | ')} |`
  const rows = table.rows.map(r => `| ${r.map(esc).join(' | ')} |`)
  return [head, `| ${sep.join(' | ')} |`, ...rows].join('\n')
}

/** Nền nhạt cho dòng chẵn: xám trong suốt, hợp cả nền sáng lẫn tối. */
const STRIPE = '#8080801f'

/** Một bảng dạng lưới: chú thích, (nút sắp xếp), các dòng chữ đơn cách trượt ngang cùng nhau, link bên dưới. */
function gridBlock(ui: ElementTable, table: Table, caption: string, controls?: RenderChildren) {
  const { Box, Text, Markdown } = ui
  const links = tableLinks(table)
  return (
    <Box flexDirection="column">
      <Text dimColor size="caption">
        {caption}
      </Text>
      {controls}
      <Box flexDirection="column" overflowX="scroll">
        {gridLines(table).map(line => (
          <Text mono bold={line.isHeader} backgroundColor={line.isStriped ? STRIPE : undefined}>
            {line.runs.map(run => {
              const s = run.style
              if (s === undefined) return run.text
              const isLink = s.link !== undefined
              return (
                <Text
                  bold={s.bold}
                  strikethrough={s.strike}
                  underline={isLink}
                  color={s.code ? 'claude' : isLink ? 'suggestion' : undefined}
                >
                  {run.text}
                </Text>
              )
            })}
          </Text>
        ))}
      </Box>
      {links !== '' && <Markdown dimColor text={`Liên kết trong bảng: ${links}`} />}
    </Box>
  )
}

function tableCaption(table: Table, no: number, total: number): string {
  const size = `${table.rows.length} dòng × ${table.header.length} cột`
  return total > 1 ? `Bảng ${no}/${total} · ${size}` : `Bảng · ${size}`
}

// ---------- Mod ----------

function showPane($: Dollar) {
  return $.ui.open({ id: PANE, title: TITLE })
}

/** File .md Claude vừa ghi: ghi vào danh sách và đưa lên pane (bảng trong đó vẽ thành lưới). */
async function onDocWritten($: Dollar, path: string, root: string, shouldOpen: boolean): Promise<void> {
  // File trong thư mục .claude (memory, plan, cấu hình) là việc nội bộ: không liệt kê, không bật pane.
  if (/[\\/]\.claude[\\/]/.test(path)) return
  const text = await $.fs.read(path).catch(() => '')
  const tables = splitSegments(text).filter(seg => seg.kind === 'table').length
  await recordDoc($, path, root, tables)
  await update($, openPath, () => path)
  // Pane bật lên trước mắt người dùng: coi như đã xem.
  if (shouldOpen) {
    void showPane($)
    await markSeen($, path)
  }
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  let lastIndexMtime = 0
  let lastDocMtime = 0
  let isDesktop = false
  let sessionCwd = ''

  on('session.start', async ($, e, next) => {
    isDesktop = e.surface === 'desktop'
    sessionCwd = e.cwd
    await $.command.register({
      name: 'md',
      description: 'Mở pane xem tài liệu Markdown (thêm đường dẫn để mở thẳng một file)',
    })
    await ensureSeen($).catch(() => undefined)

    // Tài liệu đổi ở session khác hay ngoài Claude: kiểm tra định kỳ rồi vẽ lại.
    $.clock.every(POLL_MS, async () => {
      const dir = await storeDir($)
      const indexStat = dir === undefined ? undefined : await $.fs.stat(`${dir}\\index.tsv`).catch(() => undefined)
      const path = await read($, openPath)
      const docStat = path === null ? undefined : await $.fs.stat(path).catch(() => undefined)
      const indexMtime = indexStat?.mtimeMs ?? 0
      const docMtime = docStat?.mtimeMs ?? 0
      if (indexMtime !== lastIndexMtime || docMtime !== lastDocMtime) {
        lastIndexMtime = indexMtime
        lastDocMtime = docMtime
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  on('command.run', { command: 'md' }, async ($, e) => {
    const arg = e.args.trim().replace(/^"(.*)"$/, '$1')
    if (arg !== '') {
      const isThere = await $.fs.exists(arg)
      if (!isThere) return { text: `Không tìm thấy file: ${arg}` }
      await openDoc($, arg)
    }
    await showPane($)
    return { text: arg === '' ? 'Đã mở pane MD Preview.' : `Đang xem ${baseName(arg)} trong pane MD Preview.` }
  })

  // Claude vừa ghi một file .md: mở nó trong pane.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const isWrite = e.tool === 'Write' || e.tool === 'Edit'
    const path = isWrite && 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : undefined
    if (path === undefined || !/\.(md|markdown)$/i.test(path)) return result

    // Phần của mod chỉ để xem: có lỗi gì cũng không được chặn lệnh ghi file của Claude.
    await onDocWritten($, path, sessionCwd, isDesktop).catch(() => undefined)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input, Markdown } = ui
    const path = await read($, openPath)

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="semibold">{TITLE}</Text>
          <Text dimColor>{path === null ? 'Danh sách tài liệu' : baseName(path)}</Text>
        </Box>
      )
    }

    // ----- Màn danh sách -----
    if (path === null) {
      const docs = await loadDocs($)
      const q = await read($, query)
      const now = await $.clock.now()
      const needle = q.trim().toLowerCase()
      const matched = needle === '' ? docs : docs.filter(d => d.source.toLowerCase().includes(needle))
      const shown = matched.slice(0, MAX_LIST)
      const isGridInChat = await read($, isChatGrid)
      await read($, listTick) // vẽ lại khi index.tsv hay seen.tsv đổi
      const seen = await loadSeen($)
      const unreadCount = docs.filter(d => isUnread(d, seen)).length

      return (
        <Box flexDirection="column" gap="sm">
          <Button
            key="chat-grid"
            dimColor
            label={isGridInChat ? 'Bảng trong chat: lưới cuộn ngang ✓' : 'Bảng trong chat: kiểu Claude (bấm để dùng lưới)'}
            onPress={() => update($, isChatGrid, isOn => !isOn)}
          />
          <Input
            key="search"
            placeholder="Tìm theo tên file, thư mục, dự án…"
            value={q}
            onInput={value => update($, query, () => value)}
            onSubmit={value => update($, query, () => value)}
          />
          {docs.length === 0 ? (
            <Markdown
              text={
                'Kho còn trống. Mỗi file `.md` Claude ghi sẽ tự hiện ở đây.\n\n' +
                'Mở một file có sẵn: gõ `/md đường-dẫn-file.md`.'
              }
            />
          ) : (
            <Box flexDirection="row" gap="sm" alignItems="center">
              <Text dimColor size="caption">
                {matched.length === docs.length
                  ? `${docs.length} tài liệu · mới nhất ở trên`
                  : `${matched.length}/${docs.length} tài liệu khớp “${q.trim()}”`}
                {matched.length > shown.length ? ` · đang hiện ${shown.length}` : ''}
                {unreadCount > 0 ? ` · ${unreadCount} chưa xem` : ''}
              </Text>
              {unreadCount > 0 && (
                <Button key="mark-all-seen" plain dimColor label="Đánh dấu đã xem hết" onPress={() => markAllSeen($)} />
              )}
            </Box>
          )}
          <Box flexDirection="column" gap="xs">
            {shown.map(doc => {
              const folder = folderInProject(doc)
              const where = folder === '' ? projectName(doc) : `${projectName(doc)} › ${folder}`
              return (
                <Button key={`doc:${doc.source}`} plain onPress={() => openDoc($, doc.source)}>
                  {isUnread(doc, seen) ? <Text color="claude">● </Text> : ''}
                  {baseName(doc.source)}{' '}
                  <Text dimColor>
                    {where} · {relativeTime(now, doc.updated)}
                    {doc.tables > 0 ? ` · ${doc.tables} bảng` : ''}
                  </Text>
                </Button>
              )
            })}
          </Box>
        </Box>
      )
    }

    // ----- Màn xem tài liệu (một file, hoặc bảng của một câu trả lời) -----
    const isChat = path === CHAT
    const raw = isChat ? await read($, chatText) : await $.fs.read(path).catch(() => undefined)
    const style: TableStyle = await read($, tableStyle)
    const isGrid = style === 'grid'
    const sortMap: Record<string, Sort> = await read($, sorts)

    const toolbar = (
      <Box flexDirection="row" gap="sm" alignItems="center">
        <Button key="back" label="← Danh sách" onPress={() => update($, openPath, () => null)} />
        <Button
          key="style"
          dimColor
          label={isGrid ? 'Bảng kiểu Claude' : 'Bảng cuộn ngang'}
          onPress={() => update($, tableStyle, s => (s === 'grid' ? 'markdown' : 'grid'))}
        />
        <Button key="reload" dimColor label="Tải lại" onPress={() => $.ui.invalidate('ui.render')} />
      </Box>
    )

    if (raw === undefined) {
      return (
        <Box flexDirection="column" gap="sm">
          {toolbar}
          <Text>Không đọc được file (đã bị xoá hoặc di chuyển?):</Text>
          <Text dimColor>{path}</Text>
        </Box>
      )
    }

    const isCut = raw.length > MAX_TEXT
    const text = isCut ? raw.slice(0, MAX_TEXT) : raw
    const segments = splitSegments(text)
    const tableCount = segments.filter(s => s.kind === 'table').length
    const title = isChat ? 'Bảng trong câu trả lời của Claude' : baseName(path)
    const where = isChat ? 'Từ khung chat' : path
    let tableNo = 0

    return (
      <Box flexDirection="column" gap="sm">
        {toolbar}
        <Text size="heading" weight="semibold">
          {title}
        </Text>
        <Text dimColor size="caption">
          {where} · {tableCount} bảng
        </Text>
        {segments.map(seg => {
          if (seg.kind === 'text') return <Markdown text={seg.text} />
          tableNo += 1
          const caption = tableCaption(seg.table, tableNo, tableCount)
          if (isGrid) {
            const sortKey = `${path}#${tableNo}`
            const sort = sortMap[sortKey]
            const sorted = sortTable(seg.table, sort)
            const controls = (
              <Box flexDirection="row" flexWrap="wrap" columnGap="sm" alignItems="center">
                <Text dimColor size="caption">
                  Sắp xếp:
                </Text>
                {seg.table.header.map((cell, col) => {
                  const arrow = sort?.col === col ? (sort.isDesc ? ' ▼' : ' ▲') : ''
                  return (
                    <Button
                      key={`sort:${tableNo}:${col}`}
                      plain
                      dimColor={sort?.col !== col}
                      label={`${cell.plain || `Cột ${col + 1}`}${arrow}`}
                      onPress={() =>
                        update($, sorts, map => {
                          const nextMap: Record<string, Sort> = { ...map }
                          const chosen = nextSort(nextMap[sortKey], col)
                          if (chosen === undefined) delete nextMap[sortKey]
                          else nextMap[sortKey] = chosen
                          return nextMap
                        })
                      }
                    />
                  )
                })}
              </Box>
            )
            return gridBlock(ui, sorted, `${caption} · kéo ngang để xem hết`, controls)
          }
          return (
            <Box flexDirection="column">
              <Text dimColor size="caption">
                {caption}
              </Text>
              <Markdown text={tableMarkdown(seg.table)} />
            </Box>
          )
        })}
        {isCut && <Text dimColor>… tài liệu dài quá, chỉ hiện {MAX_TEXT.toLocaleString()} ký tự đầu.</Text>}
      </Box>
    )
  })

  // Bảng trong câu trả lời của Claude: vẽ lại thành lưới cuộn ngang ngay trong khung chat.
  // Chỉ trên desktop và mobile, nơi kéo ngang được; terminal và VS Code giữ cách vẽ cũ.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const canScroll = e.surface === 'desktop' || e.surface === 'mobile'
    if (!canScroll || e.props.isSummary === true) return next(e)
    if (!(await read($, isChatGrid))) return next(e)

    const replyText = e.props.text
    const segments = splitSegments(replyText)
    const tableCount = segments.filter(s => s.kind === 'table').length
    if (tableCount === 0) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Markdown } = ui
    const openInPane = async () => {
      await update($, chatText, () => replyText)
      await update($, openPath, () => CHAT)
      await showPane($)
    }
    let tableNo = 0

    return (
      <Box flexDirection="column" gap="sm">
        {segments.map(seg => {
          if (seg.kind === 'text') return <Markdown text={seg.text} />
          tableNo += 1
          return gridBlock(ui, seg.table, tableCaption(seg.table, tableNo, tableCount))
        })}
        <Box flexDirection="row" gap="sm">
          <Button key="md-open-pane" dimColor label="Mở bảng trong pane" onPress={openInPane} />
          <Button
            key="md-chat-style"
            dimColor
            label="Dùng bảng kiểu Claude"
            onPress={() => update($, isChatGrid, () => false)}
          />
        </Box>
      </Box>
    )
  })
}
