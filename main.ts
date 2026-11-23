// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

interface Move {
  old: string;
  new: string;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// File lines (SPEC section 3)
// ---------------------------------------------------------------------------

interface Split {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Tier matching (SPEC section 5)
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(lines[i + k]!, tier) !== on[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

function firstTier(lines: string[], o: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// First line at or after `from` equal to `anchor` at the first tier with one.
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return null;
}

// First occurrence of `o` at or after `from` at the first tier with one.
// When `eof` is set the occurrence must end at the file's last line.
function findFrom(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    for (const p of occ) {
      if (p < from) continue;
      if (eof && p + o.length !== lines.length) continue;
      return { tier: t, pos: p };
    }
  }
  return null;
}

// One line of N. `ctx` is the index into O of the context line it mirrors,
// or -1 for a genuinely new line.
interface NLine {
  text: string;
  ctx: number;
}

// Replace lines[pos .. pos+oLen) with N. Context lines are written as the
// file's own matched line; at tier 2 other lines are re-indented per section 5.
function applyLines(lines: string[], pos: number, oLen: number, n: NLine[], o: string[], tier: number): string[] {
  const out = lines.slice(0, pos);
  const fLead = (lines[pos] ?? '').match(/^[ \t]*/)?.[0] ?? '';
  const pLead = (o[0] ?? '').match(/^[ \t]*/)?.[0] ?? '';
  for (const nl of n) {
    if (nl.ctx >= 0) {
      out.push(lines[pos + nl.ctx]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(pLead)) {
        out.push(fLead + t.slice(pLead.length));
      } else {
        out.push(t);
      }
    } else {
      out.push(nl.text);
    }
  }
  out.push(...lines.slice(pos + oLen));
  return out;
}

// Build O and N from a hunk/chunk body (unified and V4A share the shape).
// Also reports whether a `\` line follows the body's last context or `+` line.
interface BodyParts {
  o: string[];
  n: NLine[];
  backslashAfterLastN: boolean;
}

function bodyParts(body: string[]): BodyParts {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastN = -1;
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if (b === '' || b.startsWith(' ')) {
      const text = b === '' ? '' : b.slice(1);
      o.push(text);
      n.push({ text, ctx: o.length - 1 });
      lastN = i;
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), ctx: -1 });
      lastN = i;
    }
    // `\` lines carry no content; they are consulted below.
  }
  const backslashAfterLastN = lastN >= 0 && (body[lastN + 1] ?? '').startsWith('\\');
  return { o, n, backslashAfterLastN };
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  // Text after the four characters, up to the first tab, spaces removed.
  return line.slice(4).split('\t')[0]!.trim();
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let gitOld: string | null = null;
    let gitNew: string | null = null;
    let headerAt = -1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      gitOld = m[1]!;
      gitNew = m[2]!;
      headerAt = i;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      headerAt = i;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    // Header: from headerAt (+1 past diff --git, or at the --- line).
    let j = headerAt + (gitOld !== null ? 1 : 0);
    let oldRaw: string | undefined;
    let newRaw: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let newFileMode = false;
    let deletedFileMode = false;
    const hunks: Hunk[] = [];
    // Header lines, up to the first hunk or the next section.
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
        oldRaw = stripPrefix(headerPath(l));
        newRaw = stripPrefix(headerPath(lines[j + 1]!));
        j += 2;
        continue;
      }
      if (l.startsWith('--- ')) {
        throw new Exit2(`error: parse ${j + 2}`);
      }
      if (l.startsWith('rename from ')) {
        renameFrom = l.slice('rename from '.length).trim();
        j++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameTo = l.slice('rename to '.length).trim();
        j++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        newFileMode = true;
        j++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        deletedFileMode = true;
        j++;
        continue;
      }
      j++;
    }
    // Hunks and prose until the next section.
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (!m) throw new Exit2(`error: parse ${j + 1}`);
        const a = parseInt(m[1]!, 10);
        j++;
        const body: string[] = [];
        while (j < lines.length) {
          const b = lines[j]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
            body.push(b);
            j++;
          } else {
            break;
          }
        }
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
        hunks.push({ a, body });
        continue;
      }
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      j++;
    }
    const oldPath = oldRaw === '/dev/null' ? null : oldRaw !== undefined ? oldRaw : renameFrom !== undefined ? renameFrom : gitOld;
    const newPath = newRaw === '/dev/null' ? null : newRaw !== undefined ? newRaw : renameTo !== undefined ? renameTo : gitNew;
    sections.push({
      oldPath,
      newPath,
      isCreate: oldRaw === '/dev/null' || newFileMode,
      isDelete: newRaw === '/dev/null' || deletedFileMode,
      hunks,
    });
    i = j;
  }
  return sections;
}

function sectionEdit(s: Section, strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (s.isCreate) {
      const p = s.newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.startsWith('+')) {
            plus.push(b.slice(1));
            lastPlusBackslash = (h.body[k + 1] ?? '').startsWith('\\');
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (s.isDelete) {
      const p = s.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = s.oldPath!;
    const newPath = s.newPath!;
    const isMove = oldPath !== newPath;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const orig = tree.get(oldPath);
    if (orig === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let { lines, br, final } = splitFile(orig);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n, backslashAfterLastN } = bodyParts(h.body);
      if (o.length === 0) {
        const pos = Math.max(0, Math.min(h.a + d, lines.length));
        const atEnd = pos === lines.length;
        lines = applyLines(lines, pos, 0, n, o, 0);
        if (atEnd) final = !backslashAfterLastN;
      } else {
        const found = firstTier(lines, o, strict);
        if (found === null) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        for (const p of found.occ) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const reachesEnd = best + o.length === lines.length;
        lines = applyLines(lines, best, o.length, n, o, found.tier);
        if (reachesEnd) final = !backslashAfterLastN;
      }
      d += n.length - o.length;
    }
    const newText = joinFile(lines, br, final);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, newText);
      moves.push({ old: oldPath, new: newPath });
    } else {
      tree.now.set(oldPath, newText);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => sectionEdit(s, strict, moves));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE (SPEC section 7)
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(t);
    const found = firstTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NLine[] = newLines.map((text) => ({ text, ctx: -1 }));
    const out = applyLines(lines, pos, oldLines.length, n, oldLines, found.tier);
    tree.now.set(path, joinFile(out, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface V4aUpdate {
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
  updateLine: number;
}

function addEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function deleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function updateEdit(u: V4aUpdate, strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(u.path)) throw new Fail('unsafe', u.path);
    const t = tree.get(u.path);
    if (t === null) throw new Fail('missing', u.path);
    if (u.moveTo !== null) {
      if (!safe(u.moveTo)) throw new Fail('unsafe', u.moveTo);
      if (tree.get(u.moveTo) !== null) throw new Fail('exists', u.moveTo);
    }
    let { lines, br, final } = splitFile(t);
    let cursor = 0;
    for (const ch of u.chunks) {
      const { o, n } = bodyParts(ch.body);
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', u.path);
        cursor = at + 1;
      }
      if (o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        lines = applyLines(lines, pos, 0, n, o, 0);
        cursor = pos + n.length;
      } else {
        const found = findFrom(lines, o, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', u.path);
        lines = applyLines(lines, found.pos, o.length, n, o, found.tier);
        cursor = found.pos + n.length;
      }
    }
    const newText = joinFile(lines, br, final);
    if (u.moveTo !== null) {
      tree.now.set(u.path, null);
      tree.now.set(u.moveTo, newText);
      moves.push({ old: u.path, new: u.moveTo });
    } else {
      tree.now.set(u.path, newText);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${first + 1}`);
  }
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') ||
    l.startsWith('*** Delete File:') ||
    l.startsWith('*** Update File:');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      if (path === '') throw new Exit2(`error: parse ${i + 1}`);
      i++;
      const body: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (blank(b) || b.startsWith('+')) {
          body.push(b);
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      const fileLines = body.map((b) => (blank(b) ? '' : b.slice(1)));
      edits.push(addEdit(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      if (path === '') throw new Exit2(`error: parse ${i + 1}`);
      edits.push(deleteEdit(path));
      i++;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      if (path === '') throw new Exit2(`error: parse ${i + 1}`);
      const updateLine = i + 1;
      i++;
      while (i < last && blank(lines[i]!)) i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        if (moveTo === '') throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (b.startsWith('*** Move to:')) {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i++;
          continue;
        }
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = b.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          i++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(b);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      for (const ch of chunks) {
        while (ch.body.length > 0 && blank(ch.body[0]!)) ch.body.shift();
        while (ch.body.length > 0 && blank(ch.body[ch.body.length - 1]!)) ch.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${updateLine}`);
      }
      edits.push(updateEdit({ path, moveTo, chunks, updateLine }, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Runner (SPEC sections 1 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: R lines for clean moves, A/D/M otherwise, byte order by the
  // path (for R, by the new path).
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.new);
    const nowOld = tree.get(m.old);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && wasNew === null && nowNew !== null && nowOld === null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
