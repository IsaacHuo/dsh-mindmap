// src/index.ts
import { homedir } from "node:os";
import { join as join2, resolve as resolve2 } from "node:path";

// src/shared/api.ts
var ROUTE_PREFIX = "/dsh-mindmap/api";

// src/shared/markdown.ts
function needsEscape(t) {
  return LIST_RE.test(t) || HEADING_RE.test(t) || t.startsWith("\\") || t.startsWith(">") || FENCE_RE.test(t);
}
function unescapeFirst(text2) {
  const m = /^(?:&#32;)+/.exec(text2);
  if (m !== null) return " ".repeat(m[0].length / 5) + text2.slice(m[0].length);
  return /^\\\[( |x|X)\]/.test(text2) ? text2.slice(1) : text2;
}
function unescapeRest(line) {
  const t = line.trimStart();
  if (!t.startsWith("\\")) return line;
  const u = t.slice(1);
  return needsEscape(u) ? line.slice(0, line.length - t.length) + u : line;
}
var LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
var HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
var CHECK_RE = /^\[( |x|X)\](?:\s+|$)([\s\S]*)$/;
var FENCE_RE = /^(```+|~~~+)/;
var QUOTE_RE = /^>\s?(.*)$/;
function indentOf(line) {
  return line.length - line.trimStart().length;
}
function addNote(item, text2, blanks) {
  item.note = item.note === void 0 ? text2 : item.note + "\n".repeat(blanks > 0 ? 2 : 1) + text2;
}
function parseMarkdown(src, options = {}) {
  const detectTitle = options.detectTitle ?? true;
  const lines = src.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\t/g, "    "));
  let h1Count = 0;
  {
    let fence = null;
    for (const l of lines) {
      const fm = FENCE_RE.exec(l.trimStart());
      if (fence !== null) {
        if (fm !== null && fm[1].startsWith(fence)) fence = null;
        continue;
      }
      if (fm !== null) {
        fence = fm[1];
        continue;
      }
      if (/^#\s+\S/.test(l)) h1Count++;
    }
  }
  const root = [];
  const headings = [];
  let list = [];
  let last = null;
  let freshHeading = null;
  let blanks = 0;
  let title;
  const container = () => headings.length > 0 ? headings[headings.length - 1].item.children : root;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      blanks++;
      continue;
    }
    const ind = indentOf(line);
    const trimmed = line.slice(ind);
    const fm = FENCE_RE.exec(trimmed);
    if (fm !== null) {
      const block = [trimmed];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        const body = l.slice(Math.min(ind, indentOf(l)));
        block.push(body);
        const close = FENCE_RE.exec(l.trimStart());
        if (close !== null && close[1].startsWith(fm[1]) && l.trimStart().slice(close[1].length).trim().length === 0) break;
      }
      i = j;
      const text2 = block.join("\n");
      const owner = last !== null && ind > last.marker ? last.item : freshHeading ?? last?.item ?? null;
      if (owner !== null) addNote(owner, text2, blanks);
      else container().push({ text: text2, children: [] });
      blanks = 0;
      continue;
    }
    const hm = HEADING_RE.exec(line);
    if (hm !== null) {
      const level = hm[1].length;
      if (detectTitle && title === void 0 && level === 1 && h1Count === 1 && root.length === 0) {
        title = hm[2];
        freshHeading = null;
      } else {
        while (headings.length > 0 && headings[headings.length - 1].level >= level) headings.pop();
        const item = { text: hm[2], children: [] };
        container().push(item);
        headings.push({ level, item });
        freshHeading = item;
      }
      list = [];
      last = null;
      blanks = 0;
      continue;
    }
    const lm = LIST_RE.exec(line);
    if (lm !== null) {
      const indent = lm[1].length;
      let text2 = lm[4] ?? "";
      let checked;
      const cb = CHECK_RE.exec(text2);
      if (cb !== null) {
        checked = cb[1] !== " ";
        text2 = cb[2];
      }
      text2 = unescapeFirst(text2);
      while (list.length > 0 && list[list.length - 1].indent >= indent) list.pop();
      const item = { text: text2, children: [] };
      if (checked !== void 0) item.checked = checked;
      (list.length > 0 ? list[list.length - 1].item.children : container()).push(item);
      list.push({ indent, item });
      last = { marker: indent, content: indent + lm[2].length + Math.max(1, lm[3].length), item };
      freshHeading = null;
      blanks = 0;
      continue;
    }
    const qm = QUOTE_RE.exec(trimmed);
    if (last !== null && ind > last.marker) {
      if (qm !== null) addNote(last.item, qm[1], 0);
      else last.item.text += "\n".repeat(blanks + 1) + unescapeRest(line.slice(Math.min(ind, last.content)));
      blanks = 0;
      continue;
    }
    const para = qm !== null ? qm[1] : trimmed;
    if (freshHeading !== null) {
      addNote(freshHeading, para, blanks);
      blanks = 0;
      continue;
    }
    container().push({ text: para, children: [] });
    list = [];
    last = null;
    blanks = 0;
  }
  return title === void 0 ? { items: root } : { title, items: root };
}

// src/shared/opml.ts
function unesc(text2) {
  return text2.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (_m, ent) => {
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    if (ent === "amp") return "&";
    const code = ent[1] === "x" ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 1114111 ? String.fromCodePoint(code) : "";
  });
}
function parseOpml(xml) {
  if (!/<opml[\s>]/i.test(xml)) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 OPML \u6587\u4EF6");
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(xml);
  const bodyAt = xml.search(/<body[\s>\/]/i);
  const body = bodyAt >= 0 ? xml.slice(bodyAt) : xml;
  const root = [];
  const stack = [];
  const tokens = /<outline\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<\/outline\s*>/gi;
  let m;
  while ((m = tokens.exec(body)) !== null) {
    if (m[0].startsWith("</")) {
      stack.pop();
      continue;
    }
    const attrs = {};
    const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(m[1] ?? "")) !== null) attrs[a[1]] = unesc(a[2] ?? a[3] ?? "");
    const item = { text: (attrs.text ?? attrs.title ?? "").replace(/\r/g, ""), children: [] };
    const flag = attrs._checked ?? attrs._complete;
    if (flag === "true") item.checked = true;
    else if (attrs._checked === "false") item.checked = false;
    const note = (attrs._note ?? "").replace(/\r/g, "");
    if (note.trim().length > 0) item.note = note;
    (stack.length > 0 ? stack[stack.length - 1].children : root).push(item);
    if (m[2] !== "/") stack.push(item);
  }
  const title = titleMatch !== null ? unesc(titleMatch[1].trim()) : void 0;
  return title !== void 0 && title.length > 0 ? { title, items: root } : { items: root };
}

// src/shared/model.ts
var MAX_NODE_SESSIONS = 20;
var AI_KINDS = /* @__PURE__ */ new Set(["added", "edited", "deleted"]);
function checkAi(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const m = value;
  if (typeof m.kind !== "string" || !AI_KINDS.has(m.kind)) return "invalid kind";
  if (typeof m.at !== "number" || !Number.isFinite(m.at)) return "invalid time";
  if (m.sessionId !== void 0 && typeof m.sessionId !== "string") return "invalid session";
  if (m.prevText !== void 0 && typeof m.prevText !== "string") return "invalid prevText";
  if (m.prevNote !== void 0 && typeof m.prevNote !== "string") return "invalid prevNote";
  if (m.prevChecked !== void 0 && m.prevChecked !== null && typeof m.prevChecked !== "boolean") return "invalid prevChecked";
  return null;
}
function checkSessions(value) {
  if (!Array.isArray(value)) return "not an array";
  if (value.length > MAX_NODE_SESSIONS) return "too many";
  for (const s of value) {
    if (typeof s !== "object" || s === null) return "entry is not an object";
    const e = s;
    if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 200) return "invalid id";
    if (e.title !== void 0 && typeof e.title !== "string") return "invalid title";
    if (typeof e.createdAt !== "number") return "invalid time";
  }
  return null;
}
var MAX_IMPORT_DEPTH = 200;
function itemsDepth(items) {
  let max = 0;
  const stack = [[items, 1]];
  while (stack.length > 0) {
    const [list, depth] = stack.pop();
    for (const it of list) {
      if (depth > max) max = depth;
      if (it.children.length > 0) stack.push([it.children, depth + 1]);
    }
  }
  return max;
}
var ID_RE = /^[a-z0-9-]{6,64}$/;
var MAX_TITLE = 200;
var counter = 0;
function newId() {
  counter = (counter + 1) % 1296;
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `${Date.now().toString(36)}-${counter.toString(36).padStart(2, "0")}${rand}`;
}
function normalizeTitle(raw, fallback = "\u672A\u547D\u540D\u6587\u6863") {
  const text2 = typeof raw === "string" ? raw.replace(/[\r\n\t]+/g, " ").trim() : "";
  return (text2.length > 0 ? text2 : fallback).slice(0, MAX_TITLE);
}
function createDoc(title, now, items = [], id = newId()) {
  const rootId = newId();
  const nodes = {};
  nodes[rootId] = { id: rootId, text: "", children: [] };
  buildItems(nodes, rootId, items.length > 0 ? items : [{ text: "", children: [] }]);
  return { schema: 1, id, title: normalizeTitle(title), rootId, nodes, revision: 0, createdAt: now, updatedAt: now };
}
function nodeFromItem(item) {
  const node = { id: newId(), text: item.text, children: [] };
  if (typeof item.checked === "boolean") node.checked = item.checked;
  if (typeof item.note === "string" && item.note.length > 0) node.note = item.note;
  return node;
}
function buildItems(nodes, parentId, items) {
  const top = [];
  const stack = [];
  for (let i = items.length - 1; i >= 0; i--) stack.push([items[i], top]);
  const order = [];
  while (stack.length > 0) {
    const [item, into] = stack.pop();
    const node = nodeFromItem(item);
    nodes[node.id] = node;
    order.push([node.id, into]);
    for (let i = item.children.length - 1; i >= 0; i--) stack.push([item.children[i], node.children]);
  }
  for (const [id, into] of order) into.push(id);
  if (parentId !== null) nodes[parentId].children.push(...top);
  return top;
}
function parentMap(doc) {
  const parents = {};
  for (const node of Object.values(doc.nodes)) for (const child of node.children) parents[child] = node.id;
  return parents;
}
function validateDoc(value) {
  if (typeof value !== "object" || value === null) return "document is not an object";
  const doc = value;
  if (doc.schema !== 1) return "unsupported schema";
  if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) return "invalid document id";
  if (typeof doc.title !== "string") return "invalid title";
  if (typeof doc.revision !== "number" || !Number.isInteger(doc.revision) || doc.revision < 0) return "invalid revision";
  if (typeof doc.nodes !== "object" || doc.nodes === null) return "invalid nodes";
  if (doc.view !== void 0 && (typeof doc.view !== "object" || doc.view === null)) return "invalid view";
  const root = doc.nodes[doc.rootId];
  if (root === void 0) return "root node missing";
  const seen = /* @__PURE__ */ new Set();
  const stack = [doc.rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) return `node ${id} is referenced more than once`;
    seen.add(id);
    const node = doc.nodes[id];
    if (node === void 0) return `dangling child reference ${id}`;
    if (node.id !== id) return `node key mismatch ${id}`;
    if (typeof node.text !== "string") return `node ${id} has no text`;
    if (node.note !== void 0 && typeof node.note !== "string") return `node ${id} has an invalid note`;
    if (node.ai !== void 0) {
      const p = checkAi(node.ai);
      if (p !== null) return `node ${id} has an invalid ai mark (${p})`;
    }
    if (node.sessions !== void 0) {
      const p = checkSessions(node.sessions);
      if (p !== null) return `node ${id} has invalid sessions (${p})`;
    }
    if (!Array.isArray(node.children)) return `node ${id} has no children array`;
    for (const child of node.children) {
      if (typeof child !== "string") return `node ${id} has a non-string child`;
      stack.push(child);
    }
  }
  const total = Object.keys(doc.nodes).length;
  if (seen.size !== total) return `${total - seen.size} orphan node(s)`;
  return null;
}
function ancestors(doc, id) {
  const parents = parentMap(doc);
  const chain = [];
  let cur = parents[id];
  while (cur !== void 0) {
    chain.unshift(cur);
    cur = parents[cur];
  }
  return chain;
}
function toItems(doc, ids) {
  const out = [];
  const stack = [];
  for (let i = ids.length - 1; i >= 0; i--) stack.push([ids[i], out]);
  while (stack.length > 0) {
    const [id, into] = stack.pop();
    const node = doc.nodes[id];
    if (node === void 0) continue;
    const item = { text: node.text, children: [] };
    if (typeof node.checked === "boolean") item.checked = node.checked;
    if (typeof node.note === "string" && node.note.length > 0) item.note = node.note;
    into.push(item);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], item.children]);
  }
  return out;
}

// src/host/storage.ts
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

// src/shared/search.ts
function snippetOf(text2, at, len) {
  const flat = text2.replace(/\s+/g, " ");
  const start = Math.max(0, at - 24);
  const end = Math.min(flat.length, at + len + 40);
  return (start > 0 ? "\u2026" : "") + flat.slice(start, end) + (end < flat.length ? "\u2026" : "");
}
function indexDoc(doc) {
  const entries = [];
  const stack = (doc.nodes[doc.rootId]?.children ?? []).slice().reverse();
  while (stack.length > 0) {
    const id = stack.pop();
    const n = doc.nodes[id];
    if (n === void 0) continue;
    entries.push([id, n.text, n.note ?? ""]);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return { docId: doc.id, revision: doc.revision, entries };
}
function searchIndex(index, title, query, limit = 20) {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (q.length === 0 || limit <= 0) return [];
  const hits = [];
  const ti = title.toLowerCase().indexOf(q);
  if (ti >= 0) hits.push({ docId: index.docId, title, nodeId: null, snippet: snippetOf(title, ti, q.length) });
  for (const [id, text2, note] of index.entries) {
    if (hits.length >= limit) break;
    const at = text2.toLowerCase().replace(/\s/g, " ").indexOf(q);
    if (at >= 0) {
      hits.push({ docId: index.docId, title, nodeId: id, snippet: snippetOf(text2, at, q.length) });
      continue;
    }
    const nt = note.length > 0 ? note.toLowerCase().replace(/\s/g, " ").indexOf(q) : -1;
    if (nt >= 0) hits.push({ docId: index.docId, title, nodeId: id, snippet: snippetOf(note, nt, q.length) });
  }
  return hits;
}

// src/host/storage.ts
var BACKUP_KEEP = { daily: 14, manual: 10, "pre-restore": 5, purge: 5 };
var BACKUP_RE = /^mindmap-\d{8}(?:-\d{6})?(?:-(?:pre-restore|purge))?\.json$/;
var TRASH_RETENTION_MS = 30 * 24 * 3600 * 1e3;
var DOC_CACHE_LIMIT = 50;
var PURGE_BACKUP_DEDUPE_MS = 60 * 1e3;
function backupKind(name2) {
  if (name2.endsWith("-pre-restore.json")) return "pre-restore";
  if (name2.endsWith("-purge.json")) return "purge";
  return /^mindmap-\d{8}\.json$/.test(name2) ? "daily" : "manual";
}
var StorageError = class extends Error {
  code;
  current;
  constructor(code, message, current) {
    super(message);
    this.code = code;
    if (current !== void 0) this.current = current;
  }
};
function stamp(ms, withTime) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  return withTime ? `${day}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` : day;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function atomicWrite(file, contents) {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${Math.random().toString(36).slice(2)}.tmp`);
  const fh = await open(temp, "w");
  try {
    await fh.writeFile(contents, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = error.code;
      if (attempt >= 6 || code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        await rm(temp, { force: true }).catch(() => {
        });
        throw error;
      }
      await sleep(40 * (attempt + 1));
    }
  }
}
function isEnoent(error) {
  return error?.code === "ENOENT";
}
async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = error.code;
      if (attempt >= 8 || code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
      await sleep(50 * (attempt + 1));
    }
  }
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function sanitizeMeta(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw;
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) return null;
  const meta = {
    id: m.id,
    title: normalizeTitle(m.title),
    folderId: typeof m.folderId === "string" ? m.folderId : null,
    favorite: m.favorite === true,
    createdAt: typeof m.createdAt === "number" ? m.createdAt : 0,
    updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : 0
  };
  if (typeof m.trashedAt === "number") meta.trashedAt = m.trashedAt;
  return meta;
}
function wouldCycle(folders, id, parentId) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur = parentId;
  for (let guard = 0; cur !== null && guard <= folders.length; guard++) {
    if (cur === id) return true;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return cur !== null;
}
function sanitizeLibrary(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const l = raw;
  if (!Array.isArray(l.docs) || !Array.isArray(l.folders)) return null;
  const folders = [];
  const seenFolders = /* @__PURE__ */ new Set();
  for (const f of l.folders) {
    if (typeof f !== "object" || f === null) continue;
    const r = f;
    if (typeof r.id !== "string" || !ID_RE.test(r.id) || typeof r.name !== "string" || seenFolders.has(r.id)) continue;
    seenFolders.add(r.id);
    folders.push({ id: r.id, name: normalizeTitle(r.name, "\u65B0\u5EFA\u6587\u4EF6\u5939"), createdAt: Number(r.createdAt) || 0, parentId: typeof r.parentId === "string" ? r.parentId : null });
  }
  const ids = new Set(folders.map((f) => f.id));
  for (const f of folders) if (f.parentId !== null && f.parentId !== void 0 && !ids.has(f.parentId)) f.parentId = null;
  for (const f of folders) if (f.parentId !== null && f.parentId !== void 0 && wouldCycle(folders, f.id, f.parentId)) f.parentId = null;
  const docs = [];
  const seen = /* @__PURE__ */ new Set();
  for (const d of l.docs) {
    const meta = sanitizeMeta(d);
    if (meta === null || seen.has(meta.id)) continue;
    if (meta.folderId !== null && !ids.has(meta.folderId)) meta.folderId = null;
    seen.add(meta.id);
    docs.push(meta);
  }
  return { schema: 1, folders, docs };
}
var MindmapStorage = class {
  dir;
  now;
  library = { schema: 1, folders: [], docs: [] };
  /** LRU cache of whole documents (Map keeps insertion order). */
  docs = /* @__PURE__ */ new Map();
  /** Compact text index of every readable document, for search. */
  index = /* @__PURE__ */ new Map();
  queue = Promise.resolve();
  loading;
  pendingWarnings = [];
  lastPurgeBackup = null;
  listeners = /* @__PURE__ */ new Set();
  source = "user";
  constructor(dir, now = () => Date.now()) {
    this.dir = dir;
    this.now = now;
  }
  get libraryFile() {
    return join(this.dir, "library.json");
  }
  get docsDir() {
    return join(this.dir, "docs");
  }
  get stagingDir() {
    return join(this.dir, "docs.new");
  }
  get retiredDir() {
    return join(this.dir, "docs.old");
  }
  get restoreMarker() {
    return join(this.dir, "restore.pending.json");
  }
  get backupsDir() {
    return join(this.dir, "backups");
  }
  docFile(id) {
    return join(this.docsDir, `${id}.json`);
  }
  /** Problems found while loading that have not been reported yet. */
  get warnings() {
    return this.pendingWarnings;
  }
  /** Return the unreported warnings and forget them (each is reported once). */
  async takeWarnings() {
    await this.ready();
    const out = this.pendingWarnings;
    this.pendingWarnings = [];
    return out;
  }
  /** Serialize every mutation (and the initial load) through one queue. */
  serial(fn) {
    const run = this.queue.then(() => this.ready()).then(fn);
    this.queue = run.catch(() => void 0);
    return run;
  }
  /** Load once; later calls share the same promise. */
  ready() {
    this.loading ??= this.load();
    return this.loading;
  }
  async quarantine(file, why) {
    const target = file.replace(/\.json$/, `.corrupt-${stamp(this.now(), true)}.json`);
    await rename(file, target).catch(() => {
    });
    this.pendingWarnings.push(`${why}\uFF1A\u5DF2\u9694\u79BB\u4E3A ${target}`);
    console.warn(`[dsh-mindmap] ${why}; quarantined as ${target}`);
  }
  /**
   * Finish or roll back a restore interrupted by a crash. The marker holds the
   * library to install; docs.new present means the directory swap never
   * completed, so the old documents are put back.
   */
  async recoverRestore() {
    const marker = await readFile(this.restoreMarker, "utf8").catch(() => null);
    if (marker === null) {
      await rm(this.stagingDir, { recursive: true, force: true });
      await rm(this.retiredDir, { recursive: true, force: true });
      return;
    }
    if (await exists(this.stagingDir)) {
      if (!await exists(this.docsDir) && await exists(this.retiredDir)) await renameRetry(this.retiredDir, this.docsDir);
      await rm(this.stagingDir, { recursive: true, force: true });
      this.pendingWarnings.push("\u4E0A\u6B21\u6062\u590D\u5907\u4EFD\u672A\u5B8C\u6210\uFF0C\u5DF2\u56DE\u6EDA\u5230\u6062\u590D\u524D\u7684\u72B6\u6001");
    } else {
      await atomicWrite(this.libraryFile, marker);
      await rm(this.retiredDir, { recursive: true, force: true });
      this.pendingWarnings.push("\u4E0A\u6B21\u6062\u590D\u5907\u4EFD\u5728\u4E2D\u9014\u4E2D\u65AD\uFF0C\u5DF2\u5B8C\u6210\u6062\u590D");
    }
    await rm(this.restoreMarker, { force: true });
  }
  async load() {
    await mkdir(this.dir, { recursive: true });
    await this.recoverRestore();
    await mkdir(this.docsDir, { recursive: true });
    await mkdir(this.backupsDir, { recursive: true });
    let library = null;
    try {
      library = sanitizeLibrary(JSON.parse(await readFile(this.libraryFile, "utf8")));
      if (library === null) await this.quarantine(this.libraryFile, "library.json \u7ED3\u6784\u65E0\u6548");
    } catch (error) {
      if (!isEnoent(error)) await this.quarantine(this.libraryFile, "library.json \u65E0\u6CD5\u89E3\u6790");
    }
    const files = (await readdir(this.docsDir)).filter((f) => /^[a-z0-9-]{6,64}\.json$/.test(f));
    const lib = library ?? { schema: 1, folders: [], docs: [] };
    const known = new Set(lib.docs.map((d) => d.id));
    let adopted = false;
    for (const file of files) {
      const id = file.slice(0, -5);
      if (known.has(id)) continue;
      const doc = await this.readDocFile(id).catch(() => null);
      if (doc === null) continue;
      lib.docs.push({ id, title: doc.title, folderId: null, favorite: false, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
      adopted = true;
    }
    const present = new Set(files.map((f) => f.slice(0, -5)));
    const before = lib.docs.length;
    lib.docs = lib.docs.filter((d) => present.has(d.id));
    this.library = lib;
    if (adopted || library === null || lib.docs.length !== before) {
      if (lib.docs.length > 0 || library !== null) await this.writeLibrary();
    }
    const cutoff = this.now() - TRASH_RETENTION_MS;
    const expired = lib.docs.filter((d) => d.trashedAt !== void 0 && d.trashedAt < cutoff).map((d) => d.id);
    if (expired.length > 0) {
      try {
        await this.purgeIds(expired);
      } catch (error) {
        console.warn("[dsh-mindmap] trash auto-purge failed:", error);
      }
    }
  }
  async readDocFile(id) {
    const file = this.docFile(id);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (isEnoent(error)) throw new StorageError("not_found", "\u6587\u6863\u4E0D\u5B58\u5728");
      await this.quarantine(file, `\u6587\u6863 ${id} \u65E0\u6CD5\u89E3\u6790`);
      throw new StorageError("internal", "\u6587\u6863\u6587\u4EF6\u5DF2\u635F\u574F\u5E76\u5DF2\u9694\u79BB");
    }
    const problem = validateDoc(parsed);
    if (problem !== null || parsed.id !== id) {
      await this.quarantine(file, `\u6587\u6863 ${id} \u7ED3\u6784\u65E0\u6548\uFF08${problem ?? "id \u4E0D\u5339\u914D"}\uFF09`);
      throw new StorageError("internal", "\u6587\u6863\u6587\u4EF6\u7ED3\u6784\u65E0\u6548\u5E76\u5DF2\u9694\u79BB");
    }
    return parsed;
  }
  async writeLibrary() {
    await atomicWrite(this.libraryFile, JSON.stringify(this.library, null, 1));
    this.emit({ kind: "library" });
  }
  /** Subscribe to saved changes (documents and the library); returns an unsubscriber. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (error) {
        console.warn("[dsh-mindmap] change listener failed:", error);
      }
    }
  }
  /** Absolute path of a document's JSON file (read-only use: edits must go through this service). */
  docPath(id) {
    if (!ID_RE.test(id)) throw new StorageError("invalid_input", "\u65E0\u6548\u7684\u6587\u6863 id");
    return this.docFile(id);
  }
  /** Absolute documents directory. */
  get documentsDir() {
    return this.docsDir;
  }
  /**
   * Read-modify-write one document inside the serial queue (used by the agent
   * tool). `fn` returns the next document (or the same object for a no-op)
   * plus a result; the revision is bumped and a change event is emitted.
   * Trashed documents are refused.
   */
  mutateDoc(id, fn, source = "ai") {
    return this.serial(async () => {
      const meta = this.meta(id);
      if (meta.trashedAt !== void 0) throw new StorageError("invalid_input", "\u6587\u6863\u5728\u56DE\u6536\u7AD9\u4E2D\uFF0C\u4E0D\u80FD\u4FEE\u6539");
      const current = await this.loadDoc(id);
      const out = fn(structuredClone(current));
      if (out.doc === current || JSON.stringify(out.doc.nodes) === JSON.stringify(current.nodes) && out.doc.title === current.title) {
        return { doc: current, result: out.result, changed: false };
      }
      if (out.doc.id !== id) throw new StorageError("invalid_input", "\u6587\u6863 id \u4E0D\u5339\u914D");
      await this.dailyBackup();
      const now = this.now();
      const next = { ...out.doc, title: normalizeTitle(out.doc.title), revision: current.revision + 1, createdAt: current.createdAt, updatedAt: now };
      this.source = source;
      try {
        await this.writeDoc(next);
      } finally {
        this.source = "user";
      }
      meta.title = next.title;
      meta.updatedAt = now;
      await this.writeLibrary();
      return { doc: next, result: out.result, changed: true };
    });
  }
  remember(doc) {
    this.docs.delete(doc.id);
    this.docs.set(doc.id, doc);
    while (this.docs.size > DOC_CACHE_LIMIT) this.docs.delete(this.docs.keys().next().value);
    this.index.set(doc.id, indexDoc(doc));
  }
  async writeDoc(doc) {
    const problem = validateDoc(doc);
    if (problem !== null) throw new StorageError("invalid_input", `\u6587\u6863\u7ED3\u6784\u65E0\u6548\uFF1A${problem}`);
    await atomicWrite(this.docFile(doc.id), JSON.stringify(doc));
    this.remember(doc);
    this.emit({ kind: "doc", docId: doc.id, revision: doc.revision, source: this.source });
  }
  meta(id) {
    if (!ID_RE.test(id)) throw new StorageError("invalid_input", "\u65E0\u6548\u7684\u6587\u6863 id");
    const meta = this.library.docs.find((d) => d.id === id);
    if (meta === void 0) throw new StorageError("not_found", "\u6587\u6863\u4E0D\u5B58\u5728");
    return meta;
  }
  async loadDoc(id) {
    this.meta(id);
    const cached = this.docs.get(id);
    if (cached !== void 0) {
      this.docs.delete(id);
      this.docs.set(id, cached);
      return cached;
    }
    const doc = await this.readDocFile(id);
    this.remember(doc);
    return doc;
  }
  checkFolder(folderId) {
    if (folderId === null || folderId === void 0) return null;
    if (typeof folderId !== "string" || !this.library.folders.some((f) => f.id === folderId)) throw new StorageError("invalid_input", "\u6587\u4EF6\u5939\u4E0D\u5B58\u5728");
    return folderId;
  }
  /** A copy of the library index. */
  async getLibrary() {
    await this.ready();
    return structuredClone(this.library);
  }
  async getDoc(id) {
    await this.ready();
    return this.serial(() => this.loadDoc(id));
  }
  createDoc(input) {
    return this.serial(async () => {
      const folderId = this.checkFolder(input.folderId);
      const items = input.items ?? [];
      if (itemsDepth(items) > MAX_IMPORT_DEPTH) throw new StorageError("invalid_input", `\u5C42\u7EA7\u8D85\u8FC7 ${MAX_IMPORT_DEPTH} \u7EA7\uFF0C\u65E0\u6CD5\u5BFC\u5165`);
      await this.dailyBackup();
      const now = this.now();
      const doc = createDoc(normalizeTitle(input.title), now, items);
      await this.writeDoc(doc);
      const meta = { id: doc.id, title: doc.title, folderId, favorite: false, createdAt: now, updatedAt: now };
      this.library.docs.push(meta);
      await this.writeLibrary();
      return { meta: { ...meta }, doc };
    });
  }
  /** Optimistic-concurrency save: `baseRevision` must match the stored revision. */
  saveDoc(id, incoming, baseRevision) {
    return this.serial(async () => {
      const meta = this.meta(id);
      const current = await this.loadDoc(id);
      if (typeof baseRevision !== "number" || baseRevision !== current.revision) {
        throw new StorageError("conflict", "\u6587\u6863\u5DF2\u5728\u5176\u4ED6\u7A97\u53E3\u88AB\u4FEE\u6539", current);
      }
      const problem = validateDoc(incoming);
      if (problem !== null) throw new StorageError("invalid_input", `\u6587\u6863\u7ED3\u6784\u65E0\u6548\uFF1A${problem}`);
      const doc = incoming;
      if (doc.id !== id) throw new StorageError("invalid_input", "\u6587\u6863 id \u4E0D\u5339\u914D");
      await this.dailyBackup();
      const now = this.now();
      const next = { ...doc, title: normalizeTitle(doc.title), revision: current.revision + 1, createdAt: current.createdAt, updatedAt: now };
      await this.writeDoc(next);
      meta.title = next.title;
      meta.updatedAt = now;
      await this.writeLibrary();
      return next;
    });
  }
  /** Rename / move to folder / (un)favorite. A rename also rewrites the document title. */
  patchMeta(id, body) {
    return this.serial(async () => {
      const meta = this.meta(id);
      let doc;
      if (body.folderId !== void 0) meta.folderId = this.checkFolder(body.folderId);
      if (body.favorite !== void 0) meta.favorite = body.favorite === true;
      if (body.title !== void 0) {
        const title = normalizeTitle(body.title);
        const current = await this.loadDoc(id);
        if (current.title !== title) {
          await this.dailyBackup();
          const now = this.now();
          doc = { ...current, title, revision: current.revision + 1, updatedAt: now };
          await this.writeDoc(doc);
          meta.updatedAt = now;
        }
        meta.title = title;
      }
      await this.writeLibrary();
      return doc === void 0 ? { meta: { ...meta } } : { meta: { ...meta }, doc };
    });
  }
  /** Soft delete into the trash. */
  trashDoc(id) {
    return this.serial(async () => {
      const meta = this.meta(id);
      meta.trashedAt = this.now();
      await this.writeLibrary();
      return { ...meta };
    });
  }
  restoreDoc(id) {
    return this.serial(async () => {
      const meta = this.meta(id);
      delete meta.trashedAt;
      await this.writeLibrary();
      return { ...meta };
    });
  }
  /** Remove documents for good, after one (coalesced) purge backup. Caller holds the queue. */
  async purgeIds(ids) {
    if (ids.length === 0) return;
    const last = this.lastPurgeBackup;
    if (last === null || this.now() - last.at > PURGE_BACKUP_DEDUPE_MS) {
      this.lastPurgeBackup = { at: this.now(), info: await this.backupInternal("purge") };
    }
    const gone = new Set(ids);
    this.library.docs = this.library.docs.filter((d) => !gone.has(d.id));
    await this.writeLibrary();
    for (const id of gone) {
      this.docs.delete(id);
      this.index.delete(id);
      await rm(this.docFile(id), { force: true });
    }
  }
  /** Permanent delete; only trashed documents. */
  purgeDoc(id) {
    return this.serial(async () => {
      const meta = this.meta(id);
      if (meta.trashedAt === void 0) throw new StorageError("invalid_input", "\u53EA\u80FD\u6C38\u4E45\u5220\u9664\u56DE\u6536\u7AD9\u4E2D\u7684\u6587\u6863");
      await this.purgeIds([id]);
    });
  }
  /** Permanently delete everything in the trash; returns how many documents went. */
  emptyTrash() {
    return this.serial(async () => {
      const ids = this.library.docs.filter((d) => d.trashedAt !== void 0).map((d) => d.id);
      await this.purgeIds(ids);
      return { purged: ids.length };
    });
  }
  createFolder(name2, parentId = null) {
    return this.serial(async () => {
      const parent = this.checkFolder(parentId);
      const folder = { id: newId(), name: normalizeTitle(name2, "\u65B0\u5EFA\u6587\u4EF6\u5939"), createdAt: this.now(), parentId: parent };
      this.library.folders.push(folder);
      await this.writeLibrary();
      return { ...folder };
    });
  }
  renameFolder(id, name2) {
    return this.serial(async () => {
      const folder = this.library.folders.find((f) => f.id === id);
      if (folder === void 0) throw new StorageError("not_found", "\u6587\u4EF6\u5939\u4E0D\u5B58\u5728");
      folder.name = normalizeTitle(name2, folder.name);
      await this.writeLibrary();
      return { ...folder };
    });
  }
  /** Move a folder under another folder (null = top level); cycles are refused. */
  moveFolder(id, parentId) {
    return this.serial(async () => {
      const folder = this.library.folders.find((f) => f.id === id);
      if (folder === void 0) throw new StorageError("not_found", "\u6587\u4EF6\u5939\u4E0D\u5B58\u5728");
      const parent = this.checkFolder(parentId);
      if (parent !== null && wouldCycle(this.library.folders, id, parent)) throw new StorageError("invalid_input", "\u4E0D\u80FD\u628A\u6587\u4EF6\u5939\u79FB\u5230\u5B83\u81EA\u5DF1\u7684\u5B50\u6587\u4EF6\u5939\u91CC");
      folder.parentId = parent;
      await this.writeLibrary();
      return { ...folder };
    });
  }
  /** Delete a folder; its documents and sub-folders move up one level (never deleted). */
  deleteFolder(id) {
    return this.serial(async () => {
      const folder = this.library.folders.find((f) => f.id === id);
      if (folder === void 0) throw new StorageError("not_found", "\u6587\u4EF6\u5939\u4E0D\u5B58\u5728");
      const up = folder.parentId ?? null;
      this.library.folders = this.library.folders.filter((f) => f.id !== id);
      for (const f of this.library.folders) if (f.parentId === id) f.parentId = up;
      for (const d of this.library.docs) if (d.folderId === id) d.folderId = up;
      await this.writeLibrary();
    });
  }
  /** Title + node text + note search over non-trashed documents (uses the text index). */
  search(query, limit = 100) {
    return this.serial(async () => {
      const hits = [];
      if (query.trim().length === 0) return hits;
      for (const meta of this.library.docs) {
        if (meta.trashedAt !== void 0) continue;
        if (hits.length >= limit) break;
        let idx = this.index.get(meta.id);
        if (idx === void 0) {
          try {
            idx = indexDoc(await this.readDocFile(meta.id));
            this.index.set(meta.id, idx);
          } catch {
            continue;
          }
        }
        hits.push(...searchIndex(idx, meta.title, query, limit - hits.length));
      }
      return hits;
    });
  }
  /** Quarantined (corrupt) files, newest first; paths relative to the data directory. */
  async listQuarantine() {
    await this.ready();
    const out = [];
    for (const [sub, dir] of [["", this.dir], ["docs/", this.docsDir]]) {
      for (const name2 of await readdir(dir).catch(() => [])) {
        if (!/\.corrupt-\d{8}-\d{6}\.json$/.test(name2)) continue;
        const s = await stat(join(dir, name2)).catch(() => null);
        if (s !== null && s.isFile()) out.push({ name: sub + name2, size: s.size, createdAt: s.mtimeMs });
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  // -------------------------------------------------------------- backups
  async snapshot() {
    const docs = [];
    for (const meta of this.library.docs) {
      try {
        docs.push(this.docs.get(meta.id) ?? await this.readDocFile(meta.id));
      } catch {
      }
    }
    return { schema: 1, kind: "dsh-mindmap-backup", createdAt: this.now(), library: structuredClone(this.library), docs };
  }
  async backupInternal(kind) {
    const now = this.now();
    const suffix = kind === "pre-restore" ? "-pre-restore" : kind === "purge" ? "-purge" : "";
    let name2 = kind === "daily" ? `mindmap-${stamp(now, false)}.json` : `mindmap-${stamp(now, true)}${suffix}.json`;
    for (let bump = 1; kind !== "daily" && await exists(join(this.backupsDir, name2)) && bump < 60; bump++) {
      name2 = `mindmap-${stamp(now + bump * 1e3, true)}${suffix}.json`;
    }
    const contents = JSON.stringify(await this.snapshot());
    await atomicWrite(join(this.backupsDir, name2), contents);
    await this.prune();
    return { name: name2, size: Buffer.byteLength(contents), createdAt: now, kind };
  }
  /**
   * The first write of a local day snapshots the library as it was BEFORE that
   * write, so the day's starting state is always recoverable. Empty libraries
   * are not backed up.
   */
  async dailyBackup() {
    if (this.library.docs.length === 0) return;
    const name2 = `mindmap-${stamp(this.now(), false)}.json`;
    if (await exists(join(this.backupsDir, name2))) return;
    await this.backupInternal("daily").catch((e) => console.warn("[dsh-mindmap] daily backup failed:", e));
  }
  /** Keep the newest BACKUP_KEEP[kind] files of each kind. */
  async prune() {
    const seen = { daily: 0, manual: 0, "pre-restore": 0, purge: 0 };
    for (const b of await this.listBackupsRaw()) {
      const kind = b.kind ?? "manual";
      seen[kind]++;
      if (seen[kind] > BACKUP_KEEP[kind]) await rm(join(this.backupsDir, b.name), { force: true });
    }
  }
  async listBackupsRaw() {
    const out = [];
    for (const name2 of await readdir(this.backupsDir).catch(() => [])) {
      if (!BACKUP_RE.test(name2)) continue;
      const s = await stat(join(this.backupsDir, name2)).catch(() => null);
      if (s !== null) out.push({ name: name2, size: s.size, createdAt: s.mtimeMs, kind: backupKind(name2) });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  }
  async listBackups() {
    await this.ready();
    return this.listBackupsRaw();
  }
  backupNow() {
    return this.serial(() => this.backupInternal("manual"));
  }
  async readBackup(name2) {
    await this.ready();
    if (!BACKUP_RE.test(name2)) throw new StorageError("invalid_input", "\u65E0\u6548\u7684\u5907\u4EFD\u6587\u4EF6\u540D");
    try {
      return await readFile(join(this.backupsDir, name2), "utf8");
    } catch (error) {
      if (isEnoent(error)) throw new StorageError("not_found", "\u5907\u4EFD\u4E0D\u5B58\u5728");
      throw error;
    }
  }
  /**
   * Replace everything with a backup. The current state is first saved as a
   * "-pre-restore" backup, so a restore is itself reversible. The new documents
   * are staged in docs.new/ and swapped in with directory renames; a crash at
   * any point is finished or rolled back on the next start (recoverRestore).
   */
  restore(source) {
    return this.serial(async () => {
      let raw;
      if ("name" in source) {
        const text2 = await this.readBackup(source.name);
        try {
          raw = JSON.parse(text2);
        } catch {
          throw new StorageError("invalid_input", "\u5907\u4EFD\u6587\u4EF6\u4E0D\u662F\u6709\u6548 JSON");
        }
      } else raw = source.data;
      const file = raw;
      if (typeof file !== "object" || file === null || file.kind !== "dsh-mindmap-backup" || !Array.isArray(file.docs)) {
        throw new StorageError("invalid_input", "\u4E0D\u662F\u6709\u6548\u7684\u601D\u7EF4\u5BFC\u56FE\u5907\u4EFD\u6587\u4EF6");
      }
      const library = sanitizeLibrary(file.library);
      if (library === null) throw new StorageError("invalid_input", "\u5907\u4EFD\u4E2D\u7684\u6587\u6863\u5E93\u65E0\u6548");
      for (const doc of file.docs) {
        const problem = validateDoc(doc);
        if (problem !== null) throw new StorageError("invalid_input", `\u5907\u4EFD\u4E2D\u7684\u6587\u6863\u65E0\u6548\uFF1A${problem}`);
      }
      const byId = new Map(file.docs.map((d) => [d.id, d]));
      library.docs = library.docs.filter((d) => byId.has(d.id));
      const pre = await this.backupInternal("pre-restore");
      await rm(this.stagingDir, { recursive: true, force: true });
      await rm(this.retiredDir, { recursive: true, force: true });
      await mkdir(this.stagingDir, { recursive: true });
      for (const meta of library.docs) await atomicWrite(join(this.stagingDir, `${meta.id}.json`), JSON.stringify(byId.get(meta.id)));
      const libText = JSON.stringify(library, null, 1);
      await atomicWrite(this.restoreMarker, libText);
      await renameRetry(this.docsDir, this.retiredDir);
      await renameRetry(this.stagingDir, this.docsDir);
      await atomicWrite(this.libraryFile, libText);
      await rm(this.restoreMarker, { force: true });
      await rm(this.retiredDir, { recursive: true, force: true });
      this.docs.clear();
      this.index.clear();
      this.library = library;
      return { docs: library.docs.length, preRestore: pre.name };
    });
  }
};

// src/host/routes.ts
var BODY_LIMITS = { save: 32 * 1024 * 1024, restore: 64 * 1024 * 1024, other: 1024 * 1024 };
var STATUS = { invalid_input: 400, not_found: 404, conflict: 409, too_large: 413, internal: 500 };
var ID = "([a-z0-9-]{6,64})";
var DOC_RE = new RegExp("^/docs/" + ID + "$");
var DOC_ACTION_RE = new RegExp("^/docs/" + ID + "/(save|meta|trash|restore|purge)$");
var FOLDER_ACTION_RE = new RegExp("^/folders/" + ID + "/(rename|delete|move)$");
var BACKUP_RE2 = /^\/backups\/(mindmap-\d{8}(?:-\d{6})?(?:-(?:pre-restore|purge))?\.json)(\/restore)?$/;
var LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]"]);
function send(res, status, body) {
  const text2 = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text2);
}
function ok(res, value) {
  send(res, 200, { ok: true, value });
}
function fail(res, code, message, extra = {}) {
  send(res, STATUS[code], { ok: false, error: { code, message, ...extra } });
}
function hostName(value) {
  const v = value.trim().toLowerCase();
  if (v.startsWith("[")) return v.slice(0, v.indexOf("]") + 1);
  const i = v.lastIndexOf(":");
  return i >= 0 ? v.slice(0, i) : v;
}
function checkOrigin(req) {
  const host = String(req.headers.host ?? "");
  if (host === "" || !LOOPBACK.has(hostName(host))) return false;
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(String(origin)).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}
async function readBody(req, limit) {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.toLowerCase().startsWith("application/json")) throw new StorageError("invalid_input", "\u8BF7\u6C42\u5FC5\u987B\u662F application/json");
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new StorageError("too_large", "\u8BF7\u6C42\u4F53\u8FC7\u5927");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new StorageError("too_large", "\u8BF7\u6C42\u4F53\u8FC7\u5927");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new StorageError("invalid_input", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u6709\u6548 JSON");
  }
}
function obj(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function limitFor(path) {
  if (path === "/restore") return BODY_LIMITS.restore;
  if (path === "/docs" || path.endsWith("/save")) return BODY_LIMITS.save;
  return BODY_LIMITS.other;
}
var EVENTS_HEARTBEAT_MS = 15e3;
function streamEvents(storage, req, res) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write("retry: 3000\n\n");
  const off = storage.onChange((event) => {
    res.write("event: change\ndata: " + JSON.stringify(event) + "\n\n");
  });
  const beat = setInterval(() => res.write(": ping\n\n"), EVENTS_HEARTBEAT_MS);
  beat.unref?.();
  const close = () => {
    clearInterval(beat);
    off();
  };
  req.on("close", close);
  res.on("close", close);
}
function createHandler(storage) {
  return async (req, res) => {
    try {
      if (!checkOrigin(req)) {
        send(res, 403, { ok: false, error: { code: "invalid_input", message: "\u62D2\u7EDD\u8BBF\u95EE" } });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith(ROUTE_PREFIX)) {
        fail(res, "not_found", "\u672A\u77E5\u8DEF\u5F84");
        return;
      }
      const path = url.pathname.slice(ROUTE_PREFIX.length) || "/";
      const method = req.method ?? "GET";
      if (method === "GET") {
        if (path === "/events") {
          streamEvents(storage, req, res);
          return;
        }
        if (path === "/info") {
          await storage.ready();
          ok(res, { dataDir: storage.dir, docsDir: storage.documentsDir });
          return;
        }
        if (path === "/library") {
          const library = await storage.getLibrary();
          ok(res, { library, warnings: await storage.takeWarnings() });
          return;
        }
        const doc = DOC_RE.exec(path);
        if (doc !== null) {
          ok(res, await storage.getDoc(doc[1]));
          return;
        }
        if (path === "/search") {
          ok(res, await storage.search(String(url.searchParams.get("q") ?? "").slice(0, 200)));
          return;
        }
        if (path === "/backups") {
          ok(res, await storage.listBackups());
          return;
        }
        if (path === "/health/quarantine") {
          ok(res, await storage.listQuarantine());
          return;
        }
        const backup2 = BACKUP_RE2.exec(path);
        if (backup2 !== null && backup2[2] === void 0) {
          const text2 = await storage.readBackup(backup2[1]);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="' + backup2[1] + '"', "cache-control": "no-store" });
          res.end(text2);
          return;
        }
        fail(res, "not_found", "\u672A\u77E5\u8DEF\u5F84");
        return;
      }
      if (method !== "POST") {
        fail(res, "not_found", "\u4E0D\u652F\u6301\u7684\u65B9\u6CD5");
        return;
      }
      const body = obj(await readBody(req, limitFor(path)));
      if (path === "/docs") {
        let items = [];
        let title = body.title;
        if (body.copy !== void 0) {
          const problem = validateDoc(body.copy);
          if (problem !== null) throw new StorageError("invalid_input", "\u6587\u6863\u7ED3\u6784\u65E0\u6548\uFF1A" + problem);
          const copy = body.copy;
          items = toItems(copy, copy.nodes[copy.rootId].children);
          if (title === void 0 || title === "") title = copy.title;
        } else if (typeof body.markdown === "string") {
          const parsed = parseMarkdown(body.markdown);
          items = parsed.items;
          if (title === void 0 || title === "") title = parsed.title;
        } else if (typeof body.opml === "string") {
          let parsed;
          try {
            parsed = parseOpml(body.opml);
          } catch (error) {
            throw new StorageError("invalid_input", error.message);
          }
          items = parsed.items;
          if (title === void 0 || title === "") title = parsed.title;
        }
        ok(res, await storage.createDoc({ title, folderId: body.folderId, items }));
        return;
      }
      const action = DOC_ACTION_RE.exec(path);
      if (action !== null) {
        const id = action[1];
        switch (action[2]) {
          case "save":
            ok(res, await storage.saveDoc(id, body.doc, body.baseRevision));
            return;
          case "meta":
            ok(res, await storage.patchMeta(id, body));
            return;
          case "trash":
            ok(res, await storage.trashDoc(id));
            return;
          case "restore":
            ok(res, await storage.restoreDoc(id));
            return;
          case "purge":
            await storage.purgeDoc(id);
            ok(res, null);
            return;
        }
      }
      if (path === "/trash/empty") {
        ok(res, await storage.emptyTrash());
        return;
      }
      if (path === "/folders") {
        ok(res, await storage.createFolder(body.name, body.parentId ?? null));
        return;
      }
      const folder = FOLDER_ACTION_RE.exec(path);
      if (folder !== null) {
        if (folder[2] === "rename") ok(res, await storage.renameFolder(folder[1], body.name));
        else if (folder[2] === "move") ok(res, await storage.moveFolder(folder[1], body.parentId ?? null));
        else {
          await storage.deleteFolder(folder[1]);
          ok(res, null);
        }
        return;
      }
      if (path === "/backups/now") {
        ok(res, await storage.backupNow());
        return;
      }
      const backup = BACKUP_RE2.exec(path);
      if (backup !== null && backup[2] === "/restore") {
        ok(res, await storage.restore({ name: backup[1] }));
        return;
      }
      if (path === "/restore") {
        ok(res, await storage.restore({ data: body }));
        return;
      }
      fail(res, "not_found", "\u672A\u77E5\u8DEF\u5F84");
    } catch (error) {
      if (error instanceof StorageError) {
        fail(res, error.code, error.message, error.current !== void 0 ? { current: error.current } : {});
        return;
      }
      console.error("[dsh-mindmap] route failed:", error);
      fail(res, "internal", "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF");
    }
  };
}

// src/shared/aiOps.ts
var AI_LIMITS = { ops: 200, nodes: 1e3, text: 1e4 };
var AiOpError = class extends Error {
  index;
  constructor(message, index) {
    super(index === void 0 ? message : `op #${index}: ${message}`);
    this.index = index;
  }
};
function subtree(nodes, id) {
  const out = [];
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop();
    out.push(cur);
    const n = nodes[cur];
    if (n !== void 0) stack.push(...n.children);
  }
  return out;
}
function removeSubtree(nodes, parents, id) {
  const pid = parents[id];
  if (pid !== void 0 && nodes[pid] !== void 0) nodes[pid] = { ...nodes[pid], children: nodes[pid].children.filter((c) => c !== id) };
  const gone = subtree(nodes, id);
  for (const g of gone) delete nodes[g];
  return gone;
}
function setChecked(n, checked) {
  if (checked === void 0) return;
  if (checked === null) delete n.checked;
  else n.checked = checked;
}
function setNoteField(n, note) {
  if (note === void 0) return;
  if (note.length === 0) delete n.note;
  else n.note = note;
}
function text(value, what, index) {
  if (typeof value !== "string") throw new AiOpError(`${what} must be a string`, index);
  if (value.length > AI_LIMITS.text) throw new AiOpError(`${what} is longer than ${AI_LIMITS.text} characters`, index);
  return value.replace(/\r\n?/g, "\n");
}
function optText(value, what, index) {
  return value === void 0 ? void 0 : text(value, what, index);
}
function optChecked(value, index) {
  if (value === void 0 || value === null || typeof value === "boolean") return value;
  throw new AiOpError("checked must be true, false or null", index);
}
function underDeletion(doc, id, parents = parentMap(doc)) {
  let cur = id;
  while (cur !== void 0) {
    if (doc.nodes[cur]?.ai?.kind === "deleted") return true;
    cur = parents[cur];
  }
  return false;
}
function applyAiOps(doc, opsIn, ctx) {
  if (!Array.isArray(opsIn) || opsIn.length === 0) throw new AiOpError("ops must be a non-empty array");
  if (opsIn.length > AI_LIMITS.ops) throw new AiOpError(`at most ${AI_LIMITS.ops} ops per call`);
  const nodes = { ...doc.nodes };
  const parents = parentMap(doc);
  const res = { added: [], edited: [], deleted: [], removed: [] };
  const mark = (kind, extra = {}) => {
    const m = { kind, at: ctx.now, ...extra };
    if (ctx.sessionId !== void 0) m.sessionId = ctx.sessionId;
    return m;
  };
  const view = () => ({ ...doc, nodes });
  let created = 0;
  let changed = false;
  const build = (item, index, depth) => {
    if (depth > 50) throw new AiOpError("children nested deeper than 50 levels", index);
    if (++created > AI_LIMITS.nodes) throw new AiOpError(`at most ${AI_LIMITS.nodes} new nodes per call`, index);
    const n = { id: newId(), text: text(item.text, "text", index), children: [], ai: mark("added") };
    setNoteField(n, optText(item.note, "note", index));
    setChecked(n, optChecked(item.checked, index));
    nodes[n.id] = n;
    res.added.push(n.id);
    if (item.children !== void 0) {
      if (!Array.isArray(item.children)) throw new AiOpError("children must be an array", index);
      for (const c of item.children) {
        const cid = build(c, index, depth + 1);
        parents[cid] = n.id;
        n.children.push(cid);
      }
    }
    return n.id;
  };
  opsIn.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw new AiOpError("op must be an object", index);
    const op = raw;
    switch (op.op) {
      case "add": {
        const pid = op.parentId;
        if (typeof pid !== "string" || nodes[pid] === void 0) throw new AiOpError(`unknown parentId ${String(pid)}`, index);
        if (underDeletion(view(), pid, parents)) throw new AiOpError("cannot add under a node pending deletion", index);
        const id = build(op, index, 0);
        const parent = nodes[pid];
        const children = parent.children.slice();
        const at = typeof op.index === "number" && Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, children.length)) : children.length;
        children.splice(at, 0, id);
        nodes[pid] = { ...parent, children, collapsed: false };
        parents[id] = pid;
        changed = true;
        return;
      }
      case "edit": {
        const id = op.nodeId;
        if (typeof id !== "string" || nodes[id] === void 0) throw new AiOpError(`unknown nodeId ${String(id)}`, index);
        if (id === doc.rootId) throw new AiOpError("the root node cannot be edited; rename the document instead", index);
        const cur = nodes[id];
        if (cur.ai?.kind === "deleted") throw new AiOpError("node is pending deletion; it cannot be edited", index);
        const t = optText(op.text, "text", index);
        const note = optText(op.note, "note", index);
        const checked = optChecked(op.checked, index);
        if (t === void 0 && note === void 0 && checked === void 0) throw new AiOpError("edit needs text, note or checked", index);
        const next = { ...cur };
        if (t !== void 0) next.text = t;
        setNoteField(next, note);
        setChecked(next, checked);
        const same = next.text === cur.text && (next.note ?? "") === (cur.note ?? "") && (next.checked ?? null) === (cur.checked ?? null);
        if (same) return;
        if (cur.ai === void 0) {
          next.ai = mark("edited", { prevText: cur.text, prevNote: cur.note ?? "", prevChecked: cur.checked ?? null });
        } else if (cur.ai.kind === "edited") {
          const back = next.text === cur.ai.prevText && (next.note ?? "") === (cur.ai.prevNote ?? "") && (next.checked ?? null) === (cur.ai.prevChecked ?? null);
          if (back) delete next.ai;
          else next.ai = { ...cur.ai, at: ctx.now };
        }
        nodes[id] = next;
        if (!res.edited.includes(id)) res.edited.push(id);
        changed = true;
        return;
      }
      case "delete": {
        const id = op.nodeId;
        if (typeof id !== "string" || nodes[id] === void 0) throw new AiOpError(`unknown nodeId ${String(id)}`, index);
        if (id === doc.rootId) throw new AiOpError("the root node cannot be deleted", index);
        const cur = nodes[id];
        if (cur.ai?.kind === "deleted") return;
        if (cur.ai?.kind === "added") {
          res.removed.push(...removeSubtree(nodes, parents, id));
        } else {
          const extra = cur.ai?.kind === "edited" ? { prevText: cur.ai.prevText, prevNote: cur.ai.prevNote, prevChecked: cur.ai.prevChecked } : {};
          nodes[id] = { ...cur, ai: mark("deleted", extra) };
          res.deleted.push(id);
        }
        changed = true;
        return;
      }
      default:
        throw new AiOpError(`unsupported op ${JSON.stringify(op.op)} (use add, edit or delete)`, index);
    }
  });
  const clean = (ids) => ids.filter((id) => nodes[id] !== void 0);
  return { doc: changed ? view() : doc, added: clean(res.added), edited: clean(res.edited), deleted: clean(res.deleted), removed: res.removed };
}
function nodeRef(docId, nodeId) {
  return "mindmap://" + docId + (nodeId !== void 0 ? "/" + nodeId : "");
}
function parseRef(ref) {
  const m = /^mindmap:\/\/([a-z0-9-]{6,64})(?:\/([a-z0-9-]{6,64}))?\/?$/.exec(ref.trim());
  if (m === null) return null;
  return m[2] !== void 0 ? { docId: m[1], nodeId: m[2] } : { docId: m[1] };
}

// src/host/tools.ts
var TOOL_NAME = "mindmap";
var TOOL_DESCRIPTION = [
  "Read and edit the user's mind maps / outlines (the \u601D\u7EF4\u5BFC\u56FE plugin).",
  "Actions: list (documents), read (a document or a subtree as an indented outline with node ids), search (text across documents), apply (edit a document).",
  'Documents and nodes may be addressed by docId/nodeId or by a reference "mindmap://<docId>/<nodeId>".',
  'apply takes ops: {op:"add", parentId, index?, text, note?, checked?, children?:[{text, note?, children?}]}, {op:"edit", nodeId, text?, note?, checked?: true|false|null}, {op:"delete", nodeId}.',
  "Edits are tracked for the user's review: added nodes are highlighted, edited nodes keep their original text, and delete only strikes a node through (it stays until the user accepts). You cannot accept or reject changes, and you cannot move nodes.",
  "Read before editing; use the node ids shown in brackets. Ops in one call are applied atomically, at most 200 per call."
].join(" ");
var TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "read", "search", "apply"], description: "What to do." },
    docId: { type: "string", description: "Document id, or a mindmap:// reference (read, apply)." },
    nodeId: { type: "string", description: "read: only this subtree." },
    depth: { type: "number", description: "read: max depth below the start node (default 8)." },
    query: { type: "string", description: "search: text to find." },
    ops: { type: "array", description: "apply: list of add / edit / delete operations.", items: { type: "object" } }
  },
  required: ["action"],
  additionalProperties: false
};
var READ_NODE_LIMIT = 1500;
var MARK = { added: " \u27E8AI \u65B0\u589E\xB7\u5F85\u5BA1\u27E9", edited: " \u27E8AI \u4FEE\u6539\xB7\u5F85\u5BA1\u27E9", deleted: " \u27E8AI \u5220\u9664\xB7\u5F85\u5BA1\u27E9" };
function oneLine(s) {
  return s.replace(/\r?\n/g, " \u23CE ");
}
function renderOutline(doc, startId = doc.rootId, maxDepth = 8) {
  const lines = [];
  const start = doc.nodes[startId];
  if (start === void 0) return { text: "", nodes: 0, truncated: false };
  const header = startId === doc.rootId ? `# ${doc.title}  (${nodeRef(doc.id)}, rootId ${doc.rootId}, revision ${doc.revision})` : `# ${doc.title} \u203A ${ancestors(doc, startId).filter((a) => a !== doc.rootId).map((a) => oneLine(doc.nodes[a].text)).concat(oneLine(start.text)).join(" \u203A ")}  (${nodeRef(doc.id, startId)}, revision ${doc.revision})`;
  lines.push(header);
  let count = 0;
  let truncated = false;
  const stack = [];
  const kids = startId === doc.rootId ? start.children : [startId];
  for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], 0]);
  while (stack.length > 0) {
    const [id, depth] = stack.pop();
    const n = doc.nodes[id];
    if (n === void 0) continue;
    if (count >= READ_NODE_LIMIT) {
      truncated = true;
      break;
    }
    count++;
    const pad = "  ".repeat(depth);
    const box = n.checked === true ? "[x] " : n.checked === false ? "[ ] " : "";
    const mark = n.ai !== void 0 ? MARK[n.ai.kind] + (n.ai.kind === "edited" && n.ai.prevText !== void 0 ? ` (\u539F\u6587: ${oneLine(n.ai.prevText)})` : "") : "";
    const bound = n.sessions !== void 0 && n.sessions.length > 0 ? ` \u27E8\u7ED1\u5B9A\u4F1A\u8BDD ${n.sessions.length}\u27E9` : "";
    lines.push(`${pad}- [${id}] ${box}${oneLine(n.text)}${mark}${bound}`);
    if (n.note !== void 0 && n.note.length > 0) lines.push(`${pad}  note: ${oneLine(n.note)}`);
    if (n.children.length === 0) continue;
    if (depth + 1 > maxDepth) {
      lines.push(`${pad}  \u2026 ${n.children.length} child node(s) not shown (read nodeId ${id})`);
      continue;
    }
    for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], depth + 1]);
  }
  if (truncated) lines.push(`\u2026 output truncated at ${READ_NODE_LIMIT} nodes; read a subtree with nodeId`);
  return { text: lines.join("\n"), nodes: count, truncated };
}
function resolve(args) {
  const raw = typeof args.docId === "string" ? args.docId.trim() : "";
  if (raw.length === 0) throw new AiOpError('docId is required (use action "list" to find one)');
  const ref = raw.startsWith("mindmap://") ? parseRef(raw) : { docId: raw };
  if (ref === null) throw new AiOpError("invalid mindmap:// reference");
  const nodeId = typeof args.nodeId === "string" && args.nodeId.length > 0 ? args.nodeId.startsWith("mindmap://") ? parseRef(args.nodeId)?.nodeId : args.nodeId : ref.nodeId;
  return nodeId !== void 0 ? { docId: ref.docId, nodeId } : { docId: ref.docId };
}
async function runMindmapTool(storage, argsIn, ctx = {}) {
  const args = typeof argsIn === "object" && argsIn !== null ? argsIn : {};
  try {
    switch (args.action) {
      case "list": {
        const lib = await storage.getLibrary();
        const folders = new Map(lib.folders.map((f) => [f.id, f.name]));
        const docs = lib.docs.filter((d) => d.trashedAt === void 0).sort((a, b) => b.updatedAt - a.updatedAt);
        const rows = docs.map((d) => `- ${d.title}  docId ${d.id}${d.folderId !== null ? `  folder ${folders.get(d.folderId) ?? "?"}` : ""}  updated ${new Date(d.updatedAt).toISOString()}`);
        return { ok: true, text: docs.length === 0 ? "No documents." : `${docs.length} document(s):
${rows.join("\n")}`, data: docs.map((d) => ({ id: d.id, title: d.title })) };
      }
      case "read": {
        const { docId, nodeId } = resolve(args);
        const doc = await storage.getDoc(docId);
        if (nodeId !== void 0 && doc.nodes[nodeId] === void 0) throw new AiOpError(`unknown nodeId ${nodeId}`);
        const depth = typeof args.depth === "number" && args.depth >= 0 ? Math.min(Math.floor(args.depth), 200) : 8;
        const r = renderOutline(doc, nodeId ?? doc.rootId, depth);
        return { ok: true, text: r.text, data: { docId, revision: doc.revision, nodes: r.nodes, truncated: r.truncated } };
      }
      case "search": {
        const q = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
        if (q.length === 0) throw new AiOpError("query is required");
        const hits = await storage.search(q, 50);
        const rows = hits.map((h) => `- ${h.title}  ${h.nodeId === null ? nodeRef(h.docId) + " (title)" : nodeRef(h.docId, h.nodeId)}  ${h.snippet}`);
        return { ok: true, text: hits.length === 0 ? "No matches." : rows.join("\n"), data: hits };
      }
      case "apply": {
        const { docId } = resolve(args);
        const ops = args.ops;
        if (!Array.isArray(ops)) throw new AiOpError("ops must be an array");
        const now = (ctx.now ?? Date.now)();
        const r = await storage.mutateDoc(docId, (doc) => {
          const applied = applyAiOps(doc, ops, ctx.sessionId !== void 0 ? { now, sessionId: ctx.sessionId } : { now });
          return { doc: applied.doc, result: applied };
        });
        const a = r.result;
        const summary = r.changed ? `Applied to "${r.doc.title}" (revision ${r.doc.revision}): ${a.added.length} added, ${a.edited.length} edited, ${a.deleted.length} marked for deletion${a.removed.length > 0 ? `, ${a.removed.length} unreviewed AI node(s) removed` : ""}. The user reviews these changes in the mind map.` : "No change (the ops left the document as it was).";
        const ids = a.added.length > 0 ? `
New node ids: ${a.added.join(", ")}` : "";
        return { ok: true, text: summary + ids, data: { docId, revision: r.doc.revision, added: a.added, edited: a.edited, deleted: a.deleted, removed: a.removed } };
      }
      default:
        throw new AiOpError("action must be one of list, read, search, apply");
    }
  } catch (error) {
    if (error instanceof AiOpError || error instanceof StorageError) return { ok: false, text: "Error: " + error.message };
    console.error("[dsh-mindmap] tool failed:", error);
    return { ok: false, text: "Error: internal failure" };
  }
}

// src/index.ts
var name = "dsh-mindmap";
var inject = [];
var PROMPT_SECTION = [
  "## Mind maps (\u601D\u7EF4\u5BFC\u56FE)",
  `The user keeps outlines / mind maps in the \u601D\u7EF4\u5BFC\u56FE plugin. Use the \`${TOOL_NAME}\` tool to list, read, search and edit them; never look for their files on disk.`,
  "A reference like mindmap://<docId>/<nodeId> in a message points at a document or node: read it with the tool before answering about it.",
  "Your edits are shown to the user as pending changes (added / edited with the original kept / struck through for deletion) and only the user accepts or rejects them, so describe what you changed after an apply."
].join("\n");
function dataDirectory(env = process.env) {
  if (env.DSH_MINDMAP_DIR !== void 0 && env.DSH_MINDMAP_DIR.length > 0) return resolve2(env.DSH_MINDMAP_DIR);
  const home = env.DSH_HOME !== void 0 && env.DSH_HOME.length > 0 ? env.DSH_HOME : join2(homedir(), ".dsh");
  return join2(resolve2(home), "dsh-mindmap");
}
function apply(ctx) {
  const storage = new MindmapStorage(dataDirectory());
  void storage.ready().catch((error) => console.warn("[dsh-mindmap] storage load failed:", error));
  const handler = createHandler(storage);
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler }), "dsh-mindmap: routes");
  });
  ctx.inject(["tools"], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: typeof value === "object" && value !== null && typeof value.text === "string" ? value.text : JSON.stringify(value) }]
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.id;
        const r = await runMindmapTool(storage, args, typeof sessionId === "string" ? { sessionId } : {});
        return { ok: r.ok, text: r.text, ...r.data !== void 0 ? { data: r.data } : {} };
      }
    }), "dsh-mindmap: tool");
  });
  ctx.inject(["systemPrompt"], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({ name: "dsh-mindmap:guide", order: 900, text: PROMPT_SECTION }), "dsh-mindmap: prompt");
  });
}
export {
  PROMPT_SECTION,
  apply,
  dataDirectory,
  inject,
  name
};
