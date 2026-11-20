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

/** Engine giả: một kho có 2 tài liệu, file chat.md có một bảng. */
function fakeEngine(on: On, opened: string[], writes: { path: string; text: string }[] = []) {
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('env.get', () => ({ value: HOME }))
  on('clock.now', () => ({ value: NOW_SEC * 1000 }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('index.tsv')) return { value: INDEX }
    if (e.path.endsWith('notes.md')) return { value: '# Ghi chú\n\nChỉ có chữ, không có bảng.' }
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
  expect(writes.length).toBe(0)
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
