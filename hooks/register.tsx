import { atom, read, update } from 'claude-code'
import type { ElementTable, Hook, Register } from 'claude-code'

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
  const root = doc.root.replace(/[\\/]+$/, '')
  const isInside = doc.source.toLowerCase().startsWith(root.toLowerCase() + '\\')
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
type Table = { header: string[]; aligns: Align[]; rows: string[][] }
type Segment = { kind: 'text'; text: string } | { kind: 'table'; table: Table }

const FENCE = /^\s*(```|~~~)/

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

/** Bỏ ký hiệu inline để ô bảng đọc như chữ thường. */
function plain(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/`/g, '')
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
    const header = splitRow(line).map(plain)
    const aligns = splitRow(next).map(alignOf)
    const rows: string[][] = []
    let j = i + 2
    while (j < lines.length) {
      const rowLine = lines[j] ?? ''
      if (!rowLine.includes('|') || rowLine.trim() === '') break
      const cells = splitRow(rowLine).map(plain)
      rows.push(cells)
      j++
    }
    segments.push({ kind: 'table', table: { header, aligns, rows } })
    i = j - 1
  }
  flush()
  return segments
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

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  let lineW = 0
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const wordW = textWidth(word)
    const needed = line === '' ? wordW : lineW + 1 + wordW
    if (needed <= width) {
      line = line === '' ? word : `${line} ${word}`
      lineW = needed
      continue
    }
    if (line !== '') {
      lines.push(line)
      line = ''
      lineW = 0
    }
    if (wordW <= width) {
      line = word
      lineW = wordW
      continue
    }
    for (const ch of word) {
      const chW = charWidth(ch.codePointAt(0) ?? 0)
      if (lineW + chW > width && line !== '') {
        lines.push(line)
        line = ''
        lineW = 0
      }
      line += ch
      lineW += chW
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
}

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - textWidth(text))
  if (align === 'right') return ' '.repeat(gap) + text
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + text + ' '.repeat(gap - left)
  }
  return text + ' '.repeat(gap)
}

type GridLine = { text: string; isHeader: boolean }

function gridLines(table: Table): GridLine[] {
  const ncols = Math.max(table.header.length, ...table.rows.map(r => r.length))
  const all = [table.header, ...table.rows]
  const widths: number[] = []
  for (let c = 0; c < ncols; c++) {
    const natural = Math.max(1, ...all.map(r => textWidth(r[c] ?? '')))
    widths.push(Math.min(natural, MAX_COL))
  }
  const aligns = Array.from({ length: ncols }, (_, c) => table.aligns[c] ?? 'left')
  const border = (l: string, m: string, r: string, fill: string) =>
    l + widths.map(w => fill.repeat(w + 2)).join(m) + r

  const rowLines = (row: string[], isHeader: boolean): GridLine[] => {
    const cells = widths.map((w, c) => wrap(row[c] ?? '', w))
    const height = Math.max(...cells.map(c => c.length))
    const out: GridLine[] = []
    for (let k = 0; k < height; k++) {
      const parts = cells.map((lines, c) => pad(lines[k] ?? '', widths[c] ?? 1, aligns[c] ?? 'left'))
      out.push({ text: `│ ${parts.join(' │ ')} │`, isHeader })
    }
    return out
  }

  const anyWrapped = table.rows.some(r => r.some((cell, c) => textWidth(cell) > (widths[c] ?? 0)))
  const lines: GridLine[] = [{ text: border('┌', '┬', '┐', '─'), isHeader: false }]
  lines.push(...rowLines(table.header, true))
  lines.push({ text: border('╞', '╪', '╡', '═'), isHeader: false })
  table.rows.forEach((row, i) => {
    if (anyWrapped && i > 0) lines.push({ text: border('├', '┼', '┤', '─'), isHeader: false })
    lines.push(...rowLines(row, false))
  })
  lines.push({ text: border('└', '┴', '┘', '─'), isHeader: false })
  return lines
}

/** Bảng dưới dạng Markdown, để vẽ kiểu câu trả lời của Claude. */
function tableMarkdown(table: Table): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|')
  const sep = table.header.map((_, c) => {
    const a = table.aligns[c] ?? 'left'
    if (a === 'center') return ':---:'
    if (a === 'right') return '---:'
    return '---'
  })
  const rows = [table.header, sep, ...table.rows].map(r => `| ${r.map(esc).join(' | ')} |`)
  return rows.join('\n')
}

/** Một bảng dạng lưới: chú thích ở trên, các dòng chữ đơn cách trượt ngang cùng nhau. */
function gridBlock(ui: ElementTable, table: Table, caption: string) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      <Text dimColor size="caption">
        {caption}
      </Text>
      <Box flexDirection="column" overflowX="scroll">
        {gridLines(table).map(line => (
          <Text mono bold={line.isHeader}>
            {line.text}
          </Text>
        ))}
      </Box>
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
  if (shouldOpen) void showPane($)
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
      await update($, openPath, () => arg)
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
            <Text dimColor size="caption">
              {matched.length === docs.length
                ? `${docs.length} tài liệu · mới nhất ở trên`
                : `${matched.length}/${docs.length} tài liệu khớp “${q.trim()}”`}
              {matched.length > shown.length ? ` · đang hiện ${shown.length}` : ''}
            </Text>
          )}
          <Box flexDirection="column" gap="xs">
            {shown.map(doc => {
              const folder = folderInProject(doc)
              const where = folder === '' ? projectName(doc) : `${projectName(doc)} › ${folder}`
              return (
                <Button key={`doc:${doc.source}`} plain onPress={() => update($, openPath, () => doc.source)}>
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
          if (isGrid) return gridBlock(ui, seg.table, `${caption} · kéo ngang để xem hết`)
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
