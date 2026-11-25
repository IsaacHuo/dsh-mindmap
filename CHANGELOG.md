# Changelog

## 0.3.1

工作区 (workspaces)
- Folders are replaced by DSH workspaces: the sidebar groups documents by workspace (plus 未归类), every workspace is a drop target, and the document menu has 移动到工作区. Folder create / rename / nesting is gone.
- Toolbar: a workspace picker next to 全部折叠 changes the open document's workspace.
- New documents go to the conversation's workspace (right sidebar) or the open document's workspace.
- One-time migration: documents in a folder whose name (or an ancestor's) matches a workspace move to it, the rest go to 未归类. Folder data stays in library.json; documents are still stored as JSON in the plugin data directory.
- Agent tool `list` shows each document's workspace.

Fixes
- 复制文档文件路径 against a host still running an older build now says to restart DSH instead of 「未知路径」.

## 0.3.0

AI and sessions
- Agent tool `mindmap` (list / read / search / apply) plus a short system-prompt guide. AI edits leave traces: added (green), edited (amber, original on hover), deleted (marked with strikethrough, subtree kept, never removed).
- Review: accept / reject per node or subtree from the node menu; pending badge in the toolbar lists changes with 全部接受 / 全部拒绝; all undoable.
- 以此节点新建会话: new session in the current workspace with a pre-filled prompt (path, subtree up to 8k chars, `mindmap://` reference, trace rules); the session is bound to the node (💬N badge to open / unbind).
- 插入到对话, 复制 AI 引用, 复制文档文件路径.
- Right-sidebar 思维导图 tab (compact view with document picker), opened from the session header.

Sync
- Server change stream (SSE); open documents refresh live and unsaved local edits are three-way merged with external changes instead of raising a conflict.

Fixes
- Outline: Ctrl+A a second time (text already fully selected) selects all rows.

Tests
- Unit: AI ops, three-way merge, host tool / SSE / info routes, client AI helpers.
- e2e: harness supplies tools / systemPrompt fakes; waits tolerate the SSE stream.

## 0.2.2

Fixes
- Dialogs (new folder, rename, confirm, backups) and toasts render inside the plugin, so they get the theme background, border and position instead of floating unstyled over the page. A confirm opened from a panel returns to that panel; Esc during IME composition no longer closes a dialog; page shortcuts are ignored while a dialog is open.
- Mind map opens in 向右 layout by default (docs that saved 两侧 keep it); the fit starts at the left edge.
- Editing a map node now types inside the node's own box: the editor is frameless and transparent, matches the node's font, padding and position, and the box grows with the text. No second frame or overlapping selection ring.
- Map: switching windows no longer commits and closes the editor; clicking a toolbar button while editing keeps its focus; IME input on a selected node opens the editor; Ctrl+↑/↓ stays inside a zoomed subtree; moved or dropped nodes are revealed in auto-collapsed branches; Esc cancels a node drag; the view only scrolls to a node when the selection changes; Firefox line/page wheel deltas are normalised; long URLs after a word wrap within the node width; transparent SVG export from the dark theme uses light colours; the hint is hidden on narrow windows.
- Sidebar: renaming a favourite renames only the clicked row; Enter/Esc returns focus to the row; Esc in search respects IME; trash rows keep their time on hover; storage warnings are toasted once, not on every refresh.
- Outline: Ctrl+F from the map opens the find bar; closing it returns the caret to the node; clicking fold or check boxes keeps editing focus; the tag view hides fold buttons and shows an empty-result message; textareas re-fit on width change; note text aligns with the note editor; Tab inside a note no longer leaves it; a trailing soft newline is visible.

Tests
- Unit: default map layout, wrap width bound.
- e2e: themed opaque dialog inside the plugin, default 向右 layout, in-place editor aligned with its node with no extra frame, Ctrl+F from the map.

## 0.2.1

Fixes
- Dragging the mind-map canvas or a node no longer selects text on the page.
- Alt+1-9 (open favorite) only responds while the mind-map page has focus, not in other DSH panels.
- Removed obsolete mind-map style rules that the 0.2 map styles had replaced.
- Package and README descriptions reworded.

Tests
- New e2e steps: no text selection after map drag, map keyboard editing (Tab, Esc on an empty new node, Delete, undo/redo), narrow layouts at 760/540/400 px.

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
