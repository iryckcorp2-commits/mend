// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), applies its edits to the tree of text files
// in the working directory, and writes every file or none. See SPEC.md.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set;
// the last lines hand over to runner.ts: keep them and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse failure: exit 2 with this exact line on stdout. */
class ParseFailure extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failing: exit 1 with `error: <code> <path>` for it. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** Patch lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------
// The working tree: files as the edits leave them, read lazily from disk.
// A path maps to its new text, or null when deleted; untouched paths are
// looked up on disk only when first needed.
// ---------------------------------------------------------------------------

class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();

  readDisk(p: string): string | null {
    if (!this.disk.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.disk.set(p, value);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.readDisk(p);
  }
}

type ApplyEdit = (tree: WorkTree) => void;

interface MoveRecord {
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// File text as lines (SPEC section 3).
// ---------------------------------------------------------------------------

interface FileView {
  lines: string[];
  eol: '\r\n' | '\n';
  endsWithBreak: boolean;
}

function viewFile(text: string): FileView {
  if (text === '') return { lines: [], eol: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const eol: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const endsWithBreak = text.endsWith(eol);
  if (endsWithBreak) parts.pop();
  return { lines: parts, eol, endsWithBreak };
}

function renderFile(view: FileView): string {
  if (view.lines.length === 0) return '';
  return view.lines.join(view.eol) + (view.endsWithBreak ? view.eol : '');
}

// ---------------------------------------------------------------------------
// Line matching at three tiers (SPEC section 5).
// ---------------------------------------------------------------------------

function tierNorm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where `oldLines` occurs in `lines` at this tier. */
function occurrencesAt(lines: string[], oldLines: string[], tier: number): number[] {
  const found: number[] = [];
  if (oldLines.length === 0 || oldLines.length > lines.length) return found;
  const want = oldLines.map((l) => tierNorm(l, tier));
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (tierNorm(lines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

interface TierResult {
  tier: number;
  positions: number[];
}

/** First tier (0, then 1, then 2; only 0 when strict) at which old occurs. */
function firstTierHit(lines: string[], oldLines: string[], strict: boolean): TierResult | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, oldLines, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** First line at or after `from` equal to `anchor` (single line, first tier with one). */
function findAnchorLine(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = tierNorm(anchor, tier);
    for (let i = from; i < lines.length; i++) {
      if (tierNorm(lines[i]!, tier) === want) return i;
    }
  }
  return null;
}

interface FoundAt {
  tier: number;
  pos: number;
}

/** First occurrence of `oldLines` at or after `from`, first tier with one. */
function findOccurrenceFrom(lines: string[], oldLines: string[], from: number, strict: boolean, mustEndAtLastLine: boolean): FoundAt | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (const pos of occurrencesAt(lines, oldLines, tier)) {
      if (pos < from) continue;
      if (mustEndAtLastLine && pos + oldLines.length !== lines.length) continue;
      return { tier, pos };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Applying one hunk/chunk body (SPEC section 5).
// A new line is either a context line (copied from the file's own matched
// line) or a genuinely new line (re-indented at tier 2).
// ---------------------------------------------------------------------------

interface NewLine {
  text: string;
  /** Index into O of the context line this mirrors, or -1 for a new line. */
  contextIndex: number;
}

interface BodySplit {
  oldLines: string[];
  newLines: NewLine[];
  /** True when a `\` line directly follows the body's last context or `+` line. */
  noNewlineAtEnd: boolean;
}

/** Split hunk/chunk body lines into old lines O and new lines N. */
function splitBody(body: string[]): BodySplit {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  let lastNewBodyIndex = -1;
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if (b === '' || b.startsWith(' ')) {
      const text = b === '' ? '' : b.slice(1);
      oldLines.push(text);
      newLines.push({ text, contextIndex: oldLines.length - 1 });
      lastNewBodyIndex = i;
    } else if (b.startsWith('-')) {
      oldLines.push(b.slice(1));
    } else if (b.startsWith('+')) {
      newLines.push({ text: b.slice(1), contextIndex: -1 });
      lastNewBodyIndex = i;
    }
    // `\` lines carry no content; consulted just below.
  }
  const noNewlineAtEnd = lastNewBodyIndex >= 0 && (body[lastNewBodyIndex + 1] ?? '').startsWith('\\');
  return { oldLines, newLines, noNewlineAtEnd };
}

function leadingWhitespace(s: string): string {
  return s.match(/^[ \t]*/)?.[0] ?? '';
}

/** Replace lines[pos .. pos+oldLen) with the new lines. */
function spliceLines(lines: string[], pos: number, oldLen: number, replacement: NewLine[], oldLines: string[], tier: number): string[] {
  const out = lines.slice(0, pos);
  const fileLead = leadingWhitespace(lines[pos] ?? '');
  const patchLead = leadingWhitespace(oldLines[0] ?? '');
  for (const nl of replacement) {
    if (nl.contextIndex >= 0) {
      out.push(lines[pos + nl.contextIndex]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(patchLead)) out.push(fileLead + t.slice(patchLead.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  out.push(...lines.slice(pos + oldLen));
  return out;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4).
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  /** A from `@@ -A[,B] +C[,D] @@` (1-based start line of the old side). */
  a: number;
  body: string[];
}

interface DiffSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** Path after `--- ` / `+++ `: text after the 4 chars, up to the first tab, trimmed. */
function headerPathText(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed from either path. */
function dropABPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

function isSectionStart(lines: string[], i: number): boolean {
  const l = lines[i]!;
  if (l.startsWith('diff --git ')) return true;
  return l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
}

function parseUnified(lines: string[]): DiffSection[] {
  const sections: DiffSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let gitOld: string | null = null;
    let gitNew: string | null = null;
    let headAt = -1;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (!m) throw new ParseFailure(`error: parse ${i + 1}`);
      gitOld = m[1]!;
      gitNew = m[2]!;
      headAt = i;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      headAt = i;
    } else if (line.startsWith('@@')) {
      throw new ParseFailure(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    // Header: lines up to the first hunk or the next section.
    let j = headAt + (gitOld !== null ? 1 : 0);
    let oldRaw: string | undefined;
    let newRaw: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let newFileMode = false;
    let deletedFileMode = false;
    const hunks: Hunk[] = [];
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
        oldRaw = dropABPrefix(headerPathText(l));
        newRaw = dropABPrefix(headerPathText(lines[j + 1]!));
        j += 2;
        continue;
      }
      if (l.startsWith('--- ')) throw new ParseFailure(`error: parse ${j + 2}`);
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
        const m = HUNK_HEAD.exec(l);
        if (!m) throw new ParseFailure(`error: parse ${j + 1}`);
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
      if (isSectionStart(lines, j)) break;
      j++;
    }
    const oldPath = oldRaw === '/dev/null' ? null : oldRaw !== undefined ? oldRaw : renameFrom !== undefined ? renameFrom : gitOld;
    const newPath = newRaw === '/dev/null' ? null : newRaw !== undefined ? newRaw : renameTo !== undefined ? renameTo : gitNew;
    sections.push({
      oldPath,
      newPath,
      create: oldRaw === '/dev/null' || newFileMode,
      remove: newRaw === '/dev/null' || deletedFileMode,
      hunks,
    });
    i = j;
  }
  return sections;
}

function unifiedSectionEdit(s: DiffSection, strict: boolean, moves: MoveRecord[]): ApplyEdit {
  return (tree) => {
    if (s.create) {
      const p = s.newPath!;
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      const added: string[] = [];
      let lastPlusNoNewline = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.startsWith('+')) {
            added.push(b.slice(1));
            lastPlusNoNewline = (h.body[k + 1] ?? '').startsWith('\\');
          }
        }
      }
      tree.pending.set(p, added.length === 0 ? '' : added.join('\n') + (lastPlusNoNewline ? '' : '\n'));
      return;
    }
    if (s.remove) {
      const p = s.oldPath!;
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) === null) throw new EditFailure('missing', p);
      tree.pending.set(p, null);
      return;
    }
    const oldPath = s.oldPath!;
    const newPath = s.newPath!;
    const isMove = oldPath !== newPath;
    if (!isSafePath(oldPath)) throw new EditFailure('unsafe', oldPath);
    if (isMove && !isSafePath(newPath)) throw new EditFailure('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new EditFailure('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new EditFailure('exists', newPath);
    let view = viewFile(before);
    let drift = 0;
    for (const h of s.hunks) {
      const { oldLines, newLines, noNewlineAtEnd } = splitBody(h.body);
      if (oldLines.length === 0) {
        const at = Math.max(0, Math.min(h.a + drift, view.lines.length));
        const atEnd = at === view.lines.length;
        view.lines = spliceLines(view.lines, at, 0, newLines, oldLines, 0);
        if (atEnd) view.endsWithBreak = !noNewlineAtEnd;
      } else {
        const hit = firstTierHit(view.lines, oldLines, strict);
        if (hit === null) throw new EditFailure('no-match', oldPath);
        const target = h.a - 1 + drift;
        let best = hit.positions[0]!;
        for (const p of hit.positions) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const reachesEnd = best + oldLines.length === view.lines.length;
        view.lines = spliceLines(view.lines, best, oldLines.length, newLines, oldLines, hit.tier);
        if (reachesEnd) view.endsWithBreak = !noNewlineAtEnd;
      }
      drift += newLines.length - oldLines.length;
    }
    const after = renderFile(view);
    if (isMove) {
      tree.pending.set(oldPath, null);
      tree.pending.set(newPath, after);
      moves.push({ from: oldPath, to: newPath });
    } else {
      tree.pending.set(oldPath, after);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: MoveRecord[]): ApplyEdit[] {
  return parseUnified(lines).map((s) => unifiedSectionEdit(s, strict, moves));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7).
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): ApplyEdit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.pending.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    const view = viewFile(before);
    const hit = firstTierHit(view.lines, oldLines, strict);
    if (hit === null) throw new EditFailure('no-match', path);
    if (hit.positions.length > 1) throw new EditFailure('ambiguous', path);
    const replacement: NewLine[] = newLines.map((text) => ({ text, contextIndex: -1 }));
    const out = spliceLines(view.lines, hit.positions[0]!, oldLines.length, replacement, oldLines, hit.tier);
    tree.pending.set(path, renderFile({ lines: out, eol: view.eol, endsWithBreak: view.endsWithBreak }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): ApplyEdit[] {
  const edits: ApplyEdit[] = [];
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
    // The path: nearest non-blank line before SEARCH (after the previous
    // block), not starting with three backticks once trimmed.
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const t = lines[k]!;
      if (isBlank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFailure(`error: parse ${s + 1}`);
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
    if (eq < 0) throw new ParseFailure(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new ParseFailure(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8).
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  endOfFile: boolean;
}

interface V4aUpdate {
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
  updateLine: number;
}

function v4aAddEdit(path: string, fileLines: string[]): ApplyEdit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) !== null) throw new EditFailure('exists', path);
    tree.pending.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): ApplyEdit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) === null) throw new EditFailure('missing', path);
    tree.pending.set(path, null);
  };
}

function v4aUpdateEdit(u: V4aUpdate, strict: boolean, moves: MoveRecord[]): ApplyEdit {
  return (tree) => {
    // Every path the edit names is checked for safety before anything else.
    if (!isSafePath(u.path)) throw new EditFailure('unsafe', u.path);
    if (u.moveTo !== null && !isSafePath(u.moveTo)) throw new EditFailure('unsafe', u.moveTo);
    const before = tree.get(u.path);
    if (before === null) throw new EditFailure('missing', u.path);
    if (u.moveTo !== null && tree.get(u.moveTo) !== null) throw new EditFailure('exists', u.moveTo);
    let view = viewFile(before);
    let cursor = 0;
    for (const ch of u.chunks) {
      const { oldLines, newLines } = splitBody(ch.body);
      if (ch.anchor !== null) {
        const at = findAnchorLine(view.lines, ch.anchor, cursor, strict);
        if (at === null) throw new EditFailure('no-match', u.path);
        cursor = at + 1;
      }
      if (oldLines.length === 0) {
        const at = ch.endOfFile ? view.lines.length : cursor;
        view.lines = spliceLines(view.lines, at, 0, newLines, oldLines, 0);
        cursor = at + newLines.length;
      } else {
        const found = findOccurrenceFrom(view.lines, oldLines, cursor, strict, ch.endOfFile);
        if (found === null) throw new EditFailure('no-match', u.path);
        view.lines = spliceLines(view.lines, found.pos, oldLines.length, newLines, oldLines, found.tier);
        cursor = found.pos + newLines.length;
      }
    }
    const after = renderFile(view);
    if (u.moveTo !== null) {
      tree.pending.set(u.path, null);
      tree.pending.set(u.moveTo, after);
      moves.push({ from: u.path, to: u.moveTo });
    } else {
      tree.pending.set(u.path, after);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: MoveRecord[]): ApplyEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFailure('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFailure(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFailure(`error: parse ${lines.length + 1}`);
  const isSection = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: ApplyEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      if (path === '') throw new ParseFailure(`error: parse ${i + 1}`);
      i++;
      const body: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (isSection(b)) break;
        if (isBlank(b) || b.startsWith('+')) {
          body.push(b);
          i++;
        } else {
          throw new ParseFailure(`error: parse ${i + 1}`);
        }
      }
      while (body.length > 0 && isBlank(body[body.length - 1]!)) body.pop();
      edits.push(v4aAddEdit(path, body.map((b) => (isBlank(b) ? '' : b.slice(1)))));
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      if (path === '') throw new ParseFailure(`error: parse ${i + 1}`);
      edits.push(v4aDeleteEdit(path));
      i++;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      if (path === '') throw new ParseFailure(`error: parse ${i + 1}`);
      const updateLine = i + 1;
      i++;
      while (i < last && isBlank(lines[i]!)) i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        if (moveTo === '') throw new ParseFailure(`error: parse ${i + 1}`);
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (i < last) {
        const b = lines[i]!;
        if (isSection(b)) break;
        if (b.startsWith('*** Move to:')) throw new ParseFailure(`error: parse ${i + 1}`);
        if (b === '*** End of File') {
          if (cur === null) throw new ParseFailure(`error: parse ${i + 1}`);
          cur.endOfFile = true;
          chunks.push(cur);
          cur = null;
          i++;
          continue;
        }
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = b.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], endOfFile: false };
          i++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) cur = { anchor: null, body: [], endOfFile: false };
          cur.body.push(b);
          i++;
          continue;
        }
        throw new ParseFailure(`error: parse ${i + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      for (const ch of chunks) {
        while (ch.body.length > 0 && isBlank(ch.body[0]!)) ch.body.shift();
        while (ch.body.length > 0 && isBlank(ch.body[ch.body.length - 1]!)) ch.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFailure(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit({ path, moveTo, chunks, updateLine }, strict, moves));
      continue;
    }
    throw new ParseFailure(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9).
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not a valid one. */
function jsonEditObject(v: unknown): ApplyEdit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needExisting = (tree: WorkTree): string => {
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.pending.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.pending.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const atLine = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree) => {
      const before = needExisting(tree);
      const view = viewFile(before);
      if (atLine < 0 || atLine > view.lines.length) throw new EditFailure('no-match', p);
      view.lines.splice(atLine, 0, ...added);
      tree.pending.set(p, renderFile(view));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): ApplyEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFailure('error: parse 1');
  const edits: ApplyEdit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFailure(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseFailure(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const e = jsonEditObject(item);
      if (e === null) throw new ParseFailure(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: ApplyEdit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFailure(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const a of args) {
    if (!optionsEnded && a === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: MoveRecord[] = [];
  let edits: ApplyEdit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new ParseFailure('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFailure) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const failures: EditFailure[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.pending);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.pending.clear();
      for (const [k, v] of snapshot) tree.pending.set(k, v);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return { code: 1, out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`] };
  }
  // Output rows: R for a clean move, A/D/M otherwise, in byte order of the
  // path (for R, of the new path). A path whose bytes did not change is silent.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const m of moves) {
    const wasOld = tree.readDisk(m.from);
    const wasNew = tree.readDisk(m.to);
    const nowOld = tree.get(m.from);
    const nowNew = tree.get(m.to);
    if (wasOld !== null && wasNew === null && nowNew !== null && nowOld === null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      covered.add(m.from);
      covered.add(m.to);
    }
  }
  for (const p of tree.pending.keys()) {
    if (covered.has(p)) continue;
    const was = tree.readDisk(p);
    const now = tree.pending.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!checkOnly) {
    for (const p of tree.pending.keys()) {
      const was = tree.readDisk(p);
      const now = tree.pending.get(p)!;
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
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
