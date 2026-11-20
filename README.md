# md-preview

**English** · [Tiếng Việt](README.vi.md)

A Claude Code plugin that makes Markdown easier to read, especially tables.

- **Tables in Claude's replies** are redrawn as a grid. Columns line up, long cells wrap at word boundaries, and you
  scroll a wide table sideways to see all of it. Under each table there are two buttons: one opens the table in the
  pane where it has more room, the other switches back to Claude's own table style. This applies in the desktop and
  mobile apps. In the terminal and VS Code, Claude draws tables as usual.
- **MD Preview pane** (`/md` command): a list of every `.md` file Claude has written, across all sessions, newest
  first, with a search box. Click a file to open it. Text is drawn the way Claude's replies are, and tables are drawn
  as grids you can scroll sideways.
- **Tables in the pane**:
  - Click a column name to sort by it. Each click cycles through ascending, descending and unsorted.
  - Numeric columns sort by value, including formats such as `5 516`, `1,263` and `39.7k`.
  - Cells keep bold, `code` and strikethrough.
  - Links in a table are listed, clickable, under it.
  - Every other row is shaded so you can follow it across.
- **Auto-open**: when Claude writes or edits a `.md` file, the pane shows it straight away. Files inside a `.claude`
  folder (memory, internal plans) are skipped.
- **Unread dot**: a file Claude changed that you haven't opened yet has a ● in the list. "Đánh dấu đã xem hết"
  ("mark all as read") clears every dot.

`/md path\to\file.md` opens any file directly.

The plugin's interface is in Vietnamese.

## Requirements

- Claude Code with plugin support. Grids and the pane work best in the Claude desktop app.
- Windows. The document list lives under `%USERPROFILE%`.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install md-preview --marketplace han2-n/claude-md-preview
```

Answer `y` to add the marketplace, then press Enter to pick the `user` scope so the plugin runs in every session.

From a shell:

```
claude plugin install md-preview --marketplace han2-n/claude-md-preview
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, choose Plugins, then Add
marketplace with `han2-n/claude-md-preview`, then Add plugin.

Sessions that are already open: run `/reload-plugins`. New sessions pick it up on their own.

### Install from a folder (to hack on the plugin)

Clone the repository somewhere permanent, then:

```
claude plugin marketplace add "<cloned folder>"
claude plugin install md-preview@md-preview
```

A plugin installed this way is read straight from that folder. Edit its files, then run `/reload-plugins` to load
the new version.

## Update

```
claude plugin update md-preview@md-preview
```

Then run `/reload-plugins` in open sessions.

## Data

Everything stays on your machine, in `%USERPROFILE%\.md-preview\`. The plugin never copies file contents and sends
nothing anywhere.

- `index.tsv`: one line per `.md` file Claude wrote, with its path, when it was written, how many tables it has and
  the project folder.
- `seen.tsv`: when you last opened each file, used for the unread dots.

## Uninstall

```
claude plugin uninstall md-preview@md-preview
claude plugin marketplace remove md-preview
```

Delete `%USERPROFILE%\.md-preview\` too if you want to remove the document list.

## License

MIT
