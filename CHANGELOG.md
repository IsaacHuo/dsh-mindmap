# Changelog

## 0.2.0

Data safety
- Backups are kept per kind (daily 14, manual 10, pre-restore 5, purge 5); the daily snapshot is taken before the first write of the day.
- Restore is atomic (staged in `docs.new/`, swapped, recovered on startup if interrupted).
- Trash keeps documents for 30 days, then purges them automatically; "Empty trash" added. Permanent deletes take a coalesced backup first.
- Requests are checked for a loopback `Host` and same-origin `Origin`; body limits are per route (save 32 MB, restore 64 MB, other 1 MB); server errors no longer echo internal messages.
- Quarantined (corrupt) files are listed in the backup panel; warnings are shown once.
- Changes in another tab or window are picked up (BroadcastChannel + refetch on focus); a save conflict offers 载入对方版本 / 保留我的 / 另存为副本.
- Import refuses trees deeper than 200 levels; tree code is iterative (no stack overflow on very deep documents).

Formats
- OPML: attributes containing `>` parse correctly; `_note` is imported and exported.
- Markdown: node notes round-trip as quote lines; fenced code blocks and paragraphs under headings become notes.

Outline
- Node notes, find and replace, #tag filter, row selection with batch operations, structured copy/paste, mark toggles, visual-line ↑/↓, shortcut panel (Ctrl+/), status bar with node / character / to-do counts.
- Enter on an empty last child outdents it; Backspace at the start merges more predictably; Alt+↑/↓ can move across parents.
- Undo merges typing for at most 3 s; folding is no longer an undo step; undo zooms out when the restored node is outside the focused subtree.

Mind map
- Two-sided balanced layout (toggle 两侧 / 向右), branch colours, tapered main branches, long-text ellipsis, done styling.
- Keyboard editing on the map (Tab / Enter / Delete / F2 / Space / arrows), drag to reparent, Esc on a new empty node removes it.
- Much faster on large documents (culling, memoised layout); fit keeps text readable; export checks canvas limits and offers SVG instead.

Documents
- Nested folders, drag and drop of documents and folders, sorting (recent / title / created), hover ⋯ menu, Alt+1…9 for favorites, undo toast after moving to trash, trash preview.
- New document from pasted Markdown.
- Dialogs trap focus; menus return focus to their opener; narrow windows move secondary buttons into 更多.

## 0.1.0

- First public release. npm package `@huoweifang/dsh-mindmap`, plugin id `dsh-mindmap`.
- Outline editor: unlimited levels, keyboard editing, drag and drop, focus mode, undo/redo, checkboxes, inline Markdown.
- Mind-map view over the same document: collapse, zoom, pan, fit, edit in place.
- Documents: folders, favorites, trash, search, Markdown/OPML import and export, PNG/SVG export.
- Local storage under `~/.dsh/dsh-mindmap` with atomic writes, autosave and daily backups.
