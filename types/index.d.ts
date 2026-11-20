/** `grid`: bảng tự vẽ, cột thẳng hàng, cuộn ngang. `markdown`: bảng vẽ như câu trả lời của Claude. */
export type TableStyle = 'grid' | 'markdown'

declare module 'claude-code' {
  interface PluginState {
    'md-preview': {
      /** Tài liệu đang xem; `null` là màn danh sách. */
      openPath: string | null
      /** Từ khoá lọc danh sách. */
      query: string
      tableStyle: TableStyle
      /** Câu trả lời của Claude đang mở trong pane (khi `openPath` là dấu CHAT). */
      chatText: string
      /** Vẽ lại bảng trong câu trả lời của Claude thành lưới cuộn ngang. */
      isChatGrid: boolean
      /** Cột đang sắp xếp của từng bảng trong pane, khoá `<đường dẫn>#<số bảng>`. */
      sorts: Record<string, { col: number; isDesc: boolean }>
      /** Tăng mỗi lần index.tsv hay seen.tsv đổi, để danh sách vẽ lại. */
      listTick: number
    }
  }
}
