import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const HOME = 'C:\\Users\\tester'
const DOC = 'D:\\proj\\docs\\chat.md'
const NOW_SEC = 1_800_000_000

const INDEX = [
  ['k1', DOC, `${HOME}\\.md-preview\\docs\\chat-k1.md`, String(NOW_SEC - 120), '2', 'D:\\proj'].join('\t'),
  ['k2', 'D:\\proj\\README.md', `${HOME}\\.md-preview\\docs\\README-k2.md`, String(NOW_SEC - 7200), '1', 'D:\\proj'].join('\t'),
].join('\n')

const MARKDOWN = [
  '# So sánh',
  '',
  'Đoạn mở đầu.',
  '',
  '| Repo | Database | Ghi chú |',
  '| --- | :---: | ---: |',
  '| Stoat | MongoDB | xoá hẳn |',
  '| Zulip | PostgreSQL | chuyển sang bảng lưu trữ, khôi phục được, kèm một câu thật dài để phải xuống dòng trong ô |',
  '',
  'Đoạn kết.',
].join('\n')

const PANE = {
  plugin: 'md-preview',
  component: 'Pane',
  requestId: 'md-preview',
  props: {
    title: 'MD Preview',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NUMBERS = [
  '| Repo | Node | Ghi chú |',
  '| --- | ---: | --- |',
  '| Mattermost | 83 805 | **lớn** nhất |',
  '| Stoat | 5 516 | `nhỏ` |',
  '| Zulip | 37 068 | xem [trang chủ](https://zulip.com) |',
].join('\n')

/**
 * Engine giả: một kho có 2 tài liệu, file chat.md có một bảng. Nhớ những gì mod ghi (đọc lại được
 * index.tsv, seen.tsv); `clock.ms` chỉnh được để giả thời gian trôi.
 */
function fakeEngine(
  on: On,
  opened: string[],
  writes: { path: string; text: string }[] = [],
  clock = { ms: NOW_SEC * 1000 },
) {
  const files = new Map<string, string>()
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('env.get', () => ({ value: HOME }))
  on('clock.now', () => ({ value: clock.ms }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    const written = files.get(e.path)
    if (written !== undefined) return { value: written }
    if (e.path.endsWith('index.tsv')) return { value: INDEX }
    if (e.path.endsWith('seen.tsv')) throw new Error('ENOENT: không có file')
    if (e.path.endsWith('notes.md')) return { value: '# Ghi chú\n\nChỉ có chữ, không có bảng.' }
    if (e.path.endsWith('numbers.md')) return { value: NUMBERS }
    return { value: MARKDOWN }
  })
  on('command.register', () => ({ value: { command: 'md' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
}

test('danh sách hiện tài liệu trong kho, mới nhất ở trên', async ($, on) => {
  fakeEngine(on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  const first = await ui.find({ type: 'Button', key: `doc:${DOC}` })
  expect(first?.text).toContain('chat.md')
  expect(first?.text).toContain('2 phút trước')
  expect((await ui.find({ type: 'Text', text: /2 tài liệu/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('bấm vào tài liệu: chữ vẽ bằng Markdown, bảng thành lưới cuộn ngang', async ($, on) => {
  fakeEngine(on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `doc:${DOC}` })

  expect((await ui.find({ type: 'Markdown', text: /Đoạn mở đầu/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Markdown', text: /Đoạn kết/ }))?.text).toBeDefined()
  const header = await ui.find({ type: 'Text', text: /│ Repo/ })
  expect(header?.text).toMatch(/│ Repo +│ +Database +│ +Ghi chú +│/)
  expect((await ui.find({ type: 'Text', text: /Bảng · 2 dòng × 3 cột/ }))?.text).toBeDefined()

  // Ô dài bị xuống dòng trong ô, không làm vỡ bảng: mọi dòng lưới dài bằng nhau.
  const wrapped = await ui.find({ type: 'Text', text: /│ Zulip/ })
  const top = await ui.find({ type: 'Text', text: /^┌/ })
  expect([...(wrapped?.text ?? '')].length).toBe([...(top?.text ?? '')].length)

  // Đổi sang kiểu bảng của Claude rồi quay về danh sách.
  await ui.press({ key: 'style' })
  expect((await ui.find({ type: 'Markdown', text: /\| Repo \| Database/ }))?.text).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: `doc:${DOC}` })).toBeDefined()
  await ui.unmount()
})

test('Claude ghi file .md có bảng thì pane tự mở file đó', async ($, on) => {
  const opened: string[] = []
  const writes: { path: string; text: string }[] = []
  fakeEngine(on, opened, writes)
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: DOC, content: MARKDOWN })

  expect(opened).toContain('md-preview')
  // Ghi vào danh sách: thay dòng cũ của chính file đó, giữ dòng của file khác.
  const index = writes.find(w => w.path.endsWith('index.tsv'))
  expect(index?.path).toBe(`${HOME}\\.md-preview\\index.tsv`)
  const rows = (index?.text ?? '').trim().split('\n').map(r => r.split('\t'))
  expect(rows.length).toBe(2)
  const mine = rows.find(r => r[1] === DOC)
  expect(mine?.[4]).toBe('1')
  expect(mine?.[5]).toBe('D:\\proj')
  expect(rows.some(r => r[1] === 'D:\\proj\\README.md')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /│ Repo/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('vẽ được trên mọi bề mặt', async ($, on) => {
  fakeEngine(on, [])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: `doc:${DOC}` })).toBeDefined()
    await ui.unmount()
  }
})

const REPLY = {
  plugin: 'md-preview',
  component: 'AssistantMessage',
  props: { text: MARKDOWN, isFirstOfReply: true },
} as const

/** Đứng thay cho engine: cách nó tự vẽ câu trả lời. */
function engineDrawsReply(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

test('câu trả lời có bảng trên desktop: bảng thành lưới, chữ vẫn là Markdown', async ($, on) => {
  const opened: string[] = []
  fakeEngine(on, opened)
  engineDrawsReply(on)
  const ui = await $.ui.mount({ ...REPLY, surface: 'desktop' })

  expect((await ui.find({ type: 'Markdown', text: /Đoạn mở đầu/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /│ Repo/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeUndefined()

  // Mở bảng của câu trả lời trong pane.
  await ui.press({ key: 'md-open-pane' })
  expect(opened).toContain('md-preview')
  await ui.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /Bảng trong câu trả lời/ }))?.text).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /│ Repo/ }))?.text).toBeDefined()
  await pane.unmount()
})

test('terminal, câu trả lời không có bảng, hoặc đã chọn kiểu Claude: để engine tự vẽ', async ($, on) => {
  fakeEngine(on, [])
  engineDrawsReply(on)

  const terminal = await $.ui.mount({ ...REPLY, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /^engine$/ }))?.text).toBe('engine')
  await terminal.unmount()

  const noTable = await $.ui.mount({ ...REPLY, surface: 'desktop', props: { text: 'Chỉ có chữ.', isFirstOfReply: true } })
  expect((await noTable.find({ type: 'Text', text: /^engine$/ }))?.text).toBe('engine')
  await noTable.unmount()

  const desktop = await $.ui.mount({ ...REPLY, surface: 'desktop' })
  await desktop.press({ key: 'md-chat-style' })
  await desktop.unmount()
  const again = await $.ui.mount({ ...REPLY, surface: 'desktop' })
  expect((await again.find({ type: 'Text', text: /^engine$/ }))?.text).toBe('engine')
  await again.unmount()
})

test('file .md không có bảng vẫn vào danh sách và mở được; file trong .claude bị bỏ qua', async ($, on) => {
  const opened: string[] = []
  const writes: { path: string; text: string }[] = []
  fakeEngine(on, opened, writes)
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })

  await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\tester\\.claude\\projects\\x\\memory\\note.md', content: '# nội bộ' })
  expect(writes.filter(w => w.path.endsWith('index.tsv')).length).toBe(0)
  expect(opened.length).toBe(0)

  await $.tool.call({ tool: 'Write', file_path: 'D:\\proj\\notes.md', content: '# Ghi chú' })
  const index = writes.find(w => w.path.endsWith('index.tsv'))
  const row = (index?.text ?? '').split('\n').find(r => r.includes('notes.md'))
  expect(row?.split('\t')[4]).toBe('0')
  expect(opened).toContain('md-preview')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Markdown', text: /Chỉ có chữ/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^┌/ })).toBeUndefined()
  await ui.unmount()
})

/** Dòng dữ liệu đầu tiên của lưới: dòng đầu tiên chứa một trong các tên repo. */
async function firstRepo(ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }) {
  const row = await ui.find({ type: 'Text', text: /│ (Mattermost|Stoat|Zulip) / })
  return row?.text?.match(/Mattermost|Stoat|Zulip/)?.[0]
}

test('bấm tên cột để sắp xếp: tăng, giảm, rồi bỏ; cột số sắp theo giá trị', async ($, on) => {
  fakeEngine(on, [])
  await $.session.start({ cwd: 'D:/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: 'D:/proj/numbers.md', content: NUMBERS })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await firstRepo(ui)).toBe('Mattermost')
  await ui.press({ key: 'sort:1:1' })
  expect(await firstRepo(ui)).toBe('Stoat')
  expect((await ui.find({ type: 'Button', key: 'sort:1:1' }))?.text).toContain('▲')
  await ui.press({ key: 'sort:1:1' })
  expect(await firstRepo(ui)).toBe('Mattermost')
  expect((await ui.find({ type: 'Button', key: 'sort:1:1' }))?.text).toContain('▼')
  await ui.press({ key: 'sort:1:1' })
  expect(await firstRepo(ui)).toBe('Mattermost')
  expect((await ui.find({ type: 'Button', key: 'sort:1:1' }))?.text).not.toMatch(/[▲▼]/)

  // Cột chữ: Z → A khi giảm dần.
  await ui.press({ key: 'sort:1:0' })
  await ui.press({ key: 'sort:1:0' })
  expect(await firstRepo(ui)).toBe('Zulip')
  await ui.unmount()
})

test('ô bảng giữ định dạng: bỏ dấu ** và `, link liệt kê bấm được dưới bảng', async ($, on) => {
  fakeEngine(on, [])
  await $.session.start({ cwd: 'D:/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: 'D:/proj/numbers.md', content: NUMBERS })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  const big = await ui.find({ type: 'Text', text: /│ Mattermost/ })
  expect(big?.text).toContain('lớn nhất')
  expect(big?.text).not.toContain('**')
  const small = await ui.find({ type: 'Text', text: /│ Stoat/ })
  expect(small?.text).toContain('nhỏ')
  expect(small?.text).not.toContain('`')
  const zulip = await ui.find({ type: 'Text', text: /│ Zulip/ })
  expect(zulip?.text).toContain('xem trang chủ')
  const links = await ui.find({ type: 'Markdown', text: /Liên kết trong bảng/ })
  expect(links?.text).toContain('[trang chủ](https://zulip.com)')

  // Các dòng của lưới vẫn dài bằng nhau dù có chữ đậm và code bên trong.
  const top = await ui.find({ type: 'Text', text: /^┌/ })
  expect([...(big?.text ?? '')].length).toBe([...(top?.text ?? '')].length)
  expect([...(small?.text ?? '')].length).toBe([...(top?.text ?? '')].length)
  await ui.unmount()
})

test('tài liệu Claude sửa mà chưa mở có chấm; mở ra hoặc đánh dấu hết thì mất chấm', async ($, on) => {
  const clock = { ms: NOW_SEC * 1000 }
  fakeEngine(on, [], [], clock)
  // Terminal: pane không tự bật lên, nên file vừa ghi là "chưa xem".
  await $.session.start({ cwd: 'D:/proj', surface: 'terminal', isInteractive: true })
  clock.ms += 60_000
  await $.tool.call({ tool: 'Write', file_path: 'D:/proj/numbers.md', content: NUMBERS })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'back' })
  expect((await ui.find({ type: 'Button', key: 'doc:D:/proj/numbers.md' }))?.text).toContain('●')
  expect((await ui.find({ type: 'Button', key: `doc:${DOC}` }))?.text).not.toContain('●')
  expect((await ui.find({ type: 'Text', text: /1 chưa xem/ }))?.text).toBeDefined()

  await ui.press({ key: 'mark-all-seen' })
  expect((await ui.find({ type: 'Button', key: 'doc:D:/proj/numbers.md' }))?.text).not.toContain('●')

  // Sửa lần nữa rồi mở từ danh sách: chấm biến mất khi quay lại.
  clock.ms += 60_000
  await $.tool.call({ tool: 'Write', file_path: 'D:/proj/numbers.md', content: NUMBERS })
  // Pane chuyển sang file vừa ghi; quay về danh sách thì vẫn thấy chấm vì chưa mở xem.
  await ui.press({ key: 'back' })
  expect((await ui.find({ type: 'Button', key: 'doc:D:/proj/numbers.md' }))?.text).toContain('●')
  await ui.press({ key: 'doc:D:/proj/numbers.md' })
  await ui.press({ key: 'back' })
  expect((await ui.find({ type: 'Button', key: 'doc:D:/proj/numbers.md' }))?.text).not.toContain('●')
  await ui.unmount()
})
