/**
 * Styles for AI change tracking and the AI/session chrome (v0.3): pending
 * marks in the outline and the map, the header review badge and list, the
 * session badge, and the compact right-sidebar view.
 * @module dsh-mindmap/client/aiStyles
 */
export const AI_CSS = [
  '/* v0.3 AI change tracking */',
  '.mm-app{--mm-ai-add:#2f9e5b;--mm-ai-edit:#d98b00;--mm-ai-del:var(--mm-danger)}',
  // outline rows: coloured bar on the left of the text + tint
  '.mm-node.mm-ai-added>.mm-body,.mm-node.mm-ai-edited>.mm-body,.mm-node.mm-ai-deleted>.mm-body{box-shadow:inset 3px 0 0 var(--mm-ai-c);background:color-mix(in srgb,var(--mm-ai-c) 9%,transparent);border-radius:4px;padding-left:6px}',
  '.mm-node.mm-ai-added{--mm-ai-c:var(--mm-ai-add)}',
  '.mm-node.mm-ai-edited{--mm-ai-c:var(--mm-ai-edit)}',
  '.mm-node.mm-ai-deleted{--mm-ai-c:var(--mm-ai-del)}',
  '.mm-node.mm-ai-deleted>.mm-body>.mm-text,.mm-node.mm-ai-gone>.mm-body>.mm-text,.mm-node.mm-ai-deleted>.mm-body>.mm-note,.mm-node.mm-ai-gone>.mm-body>.mm-note{text-decoration:line-through;text-decoration-color:var(--mm-ai-del);color:var(--mm-sub)}',
  // map nodes
  '.mm-map-node.mm-ai-added>.mm-box{stroke:var(--mm-ai-add);stroke-width:2}',
  '.mm-map-node.mm-ai-edited>.mm-box{stroke:var(--mm-ai-edit);stroke-width:2}',
  '.mm-map-node.mm-ai-deleted>.mm-box,.mm-map-node.mm-ai-gone>.mm-box{stroke:var(--mm-ai-del);stroke-width:2;stroke-dasharray:4 3}',
  '.mm-map-node.mm-ai-deleted>text,.mm-map-node.mm-ai-gone>text{text-decoration:line-through;opacity:.6}',
  // header badges
  '.mm-ai-badge{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid color-mix(in srgb,var(--mm-ai-edit) 50%,transparent);border-radius:12px;background:color-mix(in srgb,var(--mm-ai-edit) 12%,transparent);color:var(--mm-text);font-size:12px;cursor:pointer;flex:none}',
  '.mm-ai-badge:hover{background:color-mix(in srgb,var(--mm-ai-edit) 22%,transparent)}',
  '.mm-ai-dot{width:7px;height:7px;border-radius:50%;background:var(--mm-ai-c,var(--mm-ai-edit));flex:none}',
  '.mm-ai-dot.mm-ai-added{--mm-ai-c:var(--mm-ai-add)}.mm-ai-dot.mm-ai-edited{--mm-ai-c:var(--mm-ai-edit)}.mm-ai-dot.mm-ai-deleted{--mm-ai-c:var(--mm-ai-del)}',
  '.mm-ai-list{display:flex;flex-direction:column;gap:2px;max-height:46vh;overflow:auto;margin:4px 0}',
  '.mm-ai-item{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;font-size:13px}',
  '.mm-ai-item:hover{background:var(--mm-hover)}',
  '.mm-ai-item-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
  '.mm-ai-item-prev{color:var(--mm-sub);text-decoration:line-through}',
  '.mm-sess-badge{display:inline-flex;align-items:center;margin-left:6px;padding:0 6px;height:18px;border-radius:9px;font-size:11px;background:var(--mm-hover);color:var(--mm-sub);cursor:pointer;vertical-align:middle;border:0}',
  '.mm-sess-badge:hover{color:var(--mm-accent)}',
  // compact (right sidebar) view
  '.mm-app.mm-compact .mm-side{display:none}',
  '.mm-app.mm-compact .mm-secondary,.mm-app.mm-compact .mm-statusbar{display:none}',
  '.mm-app.mm-compact .mm-doc-inner{padding-left:12px;padding-right:12px}',
  '.mm-doc-pick{flex:0 1 180px;min-width:80px;height:26px;border:1px solid var(--mm-border);border-radius:6px;background:var(--mm-bg);color:inherit;font:inherit;font-size:13px}',
  '.mm-hdr-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;padding:0}',
  '.mm-hdr-btn:hover{background:var(--dsw-bg-hover,rgba(0,0,0,.05))}',
].join('\n')
