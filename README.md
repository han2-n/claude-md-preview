# md-preview

Plugin cho Claude Code giúp đọc Markdown dễ hơn, nhất là bảng:

- **Bảng trong câu trả lời của Claude** được vẽ lại thành lưới: cột thẳng hàng, ô dài xuống dòng theo từ,
  bảng rộng thì kéo ngang để xem hết. Dưới bảng có nút mở bảng trong pane cho rộng hơn, và nút quay về kiểu bảng
  gốc của Claude. Áp dụng trên app desktop và mobile; terminal và VS Code giữ cách vẽ của Claude.
- **Pane MD Preview** (lệnh `/md`): danh sách mọi file `.md` Claude đã ghi, ở mọi session, mới nhất ở trên, có ô tìm
  kiếm. Bấm một file để xem: chữ vẽ như câu trả lời của Claude, bảng vẽ thành lưới cuộn ngang.
- **Bảng trong pane**: bấm tên cột để sắp xếp (tăng → giảm → bỏ), cột số như `5 516`, `1,263`, `39.7k` sắp theo
  giá trị. Ô giữ chữ đậm, `code`, gạch ngang; link trong bảng được liệt kê bấm được ngay dưới bảng. Dòng chẵn tô
  nền nhạt cho dễ dò theo hàng.
- **Tự mở**: khi Claude vừa ghi hoặc sửa một file `.md`, pane hiện ngay file đó. File trong thư mục `.claude`
  (memory, plan nội bộ) được bỏ qua.
- **Chấm "chưa xem"**: file Claude sửa mà bạn chưa mở có dấu ● trong danh sách; nút "Đánh dấu đã xem hết" xoá mọi
  chấm.

`/md đường-dẫn\tới\file.md` mở thẳng một file bất kỳ.

## Cài đặt

Repository này là private: bạn cần được mời vào repo trên GitHub, và máy bạn cần có sẵn thông tin đăng nhập GitHub
cho git (SSH key, hoặc `gh auth login` rồi `gh auth setup-git`). Lệnh cài không tự hỏi đăng nhập.

Ở dấu nhắc của một session Claude Code trong terminal:

```
/plugin install md-preview --marketplace han2-n/claude-md-preview
```

trả lời `y` để thêm marketplace, rồi chọn phạm vi `user` (Enter) để plugin chạy ở mọi session.

Từ shell:

```
claude plugin install md-preview --marketplace han2-n/claude-md-preview
```

Trong app Claude desktop (nơi `/plugin` không chạy): bấm dấu + cạnh ô nhập, chọn Plugins, Add marketplace với
`han2-n/claude-md-preview`, rồi Add plugin.

Session đang mở: gõ `/reload-plugins` để nạp. Session mới tự có.

### Cài từ thư mục (để sửa plugin)

Clone repo về một chỗ cố định, rồi:

```
claude plugin marketplace add "<thư mục đã clone>"
claude plugin install md-preview@md-preview
```

Plugin cài kiểu này được đọc thẳng từ thư mục: sửa file trong đó rồi `/reload-plugins` là có bản mới.

## Dữ liệu

Danh sách tài liệu nằm ở `%USERPROFILE%\.md-preview\index.tsv` (hoặc `$HOME/.md-preview/index.tsv`): mỗi dòng
một file `.md` với đường dẫn, thời điểm Claude ghi, số bảng và thư mục dự án. Plugin không chép nội dung file,
không gửi gì ra ngoài máy.

## Gỡ

```
claude plugin uninstall md-preview@md-preview
claude plugin marketplace remove md-preview
```
