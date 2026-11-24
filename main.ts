// mend — one patch tool for every AI edit format.
// Applies a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON
// tool-call edits to a tree of text files, atomically: either every edit
// lands or nothing is written. Node 22, standard library only.
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const USAGE = "error: usage";
const NO_PATCH = "error: no-patch";
const FORMAT = "error: format";

function die(line: string, code: number): never {
  process.stdout.write(line + "\n");
  process.exit(code);
}

function failParse(n: number): never {
  die(`error: parse ${n}`, 2);
}

// ---------------------------------------------------------------------------
// Text files: a file is its lines plus the break it uses and whether it ends
// with one. The break is CRLF when the first line feed follows a CR.
// ---------------------------------------------------------------------------
class TextFile {
  brk: string;
  rows: string[];
  tail: boolean;

  constructor(brk: string, rows: string[], tail: boolean) {
    this.brk = brk;
    this.rows = rows;
    this.tail = tail;
  }

  static fromText(text: string): TextFile {
    if (text === "") return new TextFile("\n", [], false);
    const firstLf = text.indexOf("\n");
    const brk = firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
    const parts = text.split(brk);
    const tail = text.endsWith(brk);
    if (tail) parts.pop();
    return new TextFile(brk, parts, tail);
  }

  static blank(): TextFile {
    return new TextFile("\n", [], false);
  }

  render(): string {
    if (this.rows.length === 0) return "";
    return this.rows.join(this.brk) + (this.tail ? this.brk : "");
  }

  clone(): TextFile {
    return new TextFile(this.brk, [...this.rows], this.tail);
  }
}

// A patch's lines: split at \n, one trailing \r removed each, no empty piece
// after a final \n.
function patchRows(text: string): string[] {
  const rows = text.split("\n").map((r) => (r.endsWith("\r") ? r.slice(0, -1) : r));
  if (rows.length > 0 && rows[rows.length - 1] === "" && text.endsWith("\n")) rows.pop();
  return rows;
}

function blankRow(row: string): boolean {
  return row.trim() === "";
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function safePath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tier matching (SPEC section 5)
// ---------------------------------------------------------------------------
function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function trimBothWs(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function rowsEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function findSpots(body: string[], old: string[], tier: number, from: number): number[] {
  const spots: number[] = [];
  if (old.length === 0) return spots;
  for (let i = Math.max(0, from); i + old.length <= body.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!rowsEqualAt(body[i + j], old[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) spots.push(i);
  }
  return spots;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

// First tier (lowest) at which old occurs at least once at or after `from`,
// with its spots. Null when no tier matches.
function locateTier(body: string[], old: string[], strict: boolean, from = 0): { tier: number; spots: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const spots = findSpots(body, old, tier, from);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

// Build the replacement rows for a chunk/hunk. `fresh` holds the new side:
// entries are either {at: <index into old>} for a context row (written as the
// file's own row) or {text} for an added row. At tier 2, added rows are
// re-indented from the old first row's lead to the file's first matched lead.
function buildFresh(
  file: TextFile,
  at: number,
  old: string[],
  fresh: ({ at: number } | { text: string })[],
  tier: number,
): string[] {
  const out: string[] = [];
  let pfxOld = "";
  let pfxFile = "";
  if (tier === 2 && old.length > 0) {
    pfxOld = leadWs(old[0]);
    pfxFile = leadWs(file.rows[at] ?? "");
  }
  for (const item of fresh) {
    if ("at" in item) {
      out.push(file.rows[at + item.at]);
    } else {
      let line = item.text;
      if (tier === 2 && line !== "" && line.trim() !== "" && line.startsWith(pfxOld)) {
        line = pfxFile + line.slice(pfxOld.length);
      }
      out.push(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arguments (SPEC section 1)
// ---------------------------------------------------------------------------
type Args = { format: string; check: boolean; strict: boolean; patch: string | null };

function readArgs(argv: string[]): Args {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positionals: string[] = [];
  let dashdash = false;
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!dashdash && arg === "--") {
      dashdash = true;
      continue;
    }
    if (!dashdash && arg.startsWith("-") && arg !== "-") {
      if (arg === "--check" || arg === "--strict") {
        if (seen.has(arg)) die(USAGE, 2);
        seen.add(arg);
        if (arg === "--check") check = true;
        else strict = true;
        continue;
      }
      if (arg.startsWith("--format=")) {
        if (seen.has("--format")) die(USAGE, 2);
        seen.add("--format");
        const value = arg.slice("--format=".length);
        if (!["auto", "unified", "search-replace", "v4a", "json"].includes(value)) die(USAGE, 2);
        format = value;
        continue;
      }
      die(USAGE, 2);
    }
    positionals.push(arg);
  }
  if (positionals.length > 1) die(USAGE, 2);
  return { format: format ?? "auto", check, strict, patch: positionals.length === 1 ? positionals[0] : null };
}

// ---------------------------------------------------------------------------
// Edits. Every format parses into the same shape: a list of edits, each with
// the paths it touches and a function that applies it to the in-memory tree.
// A failed edit returns its failure code and path instead of throwing.
// ---------------------------------------------------------------------------
type Tree = Map<string, TextFile>;
type Failure = { code: string; path: string };
type Edit = {
  paths: string[];
  run: (tree: Tree, strict: boolean) => Failure | null;
};

function readPatchText(patch: string | null): string {
  if (patch === null || patch === "-") {
    return readFileSync(0, "utf-8");
  }
  try {
    return readFileSync(patch, "utf-8");
  } catch {
    die(NO_PATCH, 2);
  }
}

function detectKind(rows: string[]): string {
  let first = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!blankRow(rows[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) die(FORMAT, 2);
  const head = rows[first].trim();
  if (head === "*** Begin Patch") return "v4a";
  const firstChar = rows[first].trimStart()[0];
  if (firstChar === "[" || firstChar === "{") return "json";
  for (const row of rows) {
    if (row.replace(/[ \t]+$/, "") === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].startsWith("diff --git ")) return "unified";
    if (rows[i].startsWith("--- ") && i + 1 < rows.length && rows[i + 1].startsWith("+++ ")) return "unified";
  }
  die(FORMAT, 2);
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------
type BodyLine = { kind: "ctx" | "del" | "add" | "bs"; text: string; bare?: boolean };
type Hunk = { start: number; body: BodyLine[] };
type Section = {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
};

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripAB(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function headerPath(line: string): string | null {
  // line starts with "--- " or "+++ "; path is the text after 4 chars, up to
  // the first tab, with surrounding spaces removed.
  const raw = line.slice(4).split("\t")[0].trim();
  if (raw === "/dev/null") return null;
  return stripAB(raw);
}

function parseUnified(rows: string[]): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  let cur: Section | null = null;
  let inHeader = false;

  function startSection(): Section {
    const s: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
    sections.push(s);
    return s;
  }

  while (i < rows.length) {
    const row = rows[i];
    if (row.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(row);
      if (!m) failParse(i + 1);
      cur = startSection();
      cur.oldPath = m[1];
      cur.newPath = m[2];
      inHeader = true;
      i++;
      continue;
    }
    if (row.startsWith("--- ") && i + 1 < rows.length && rows[i + 1].startsWith("+++ ")) {
      if (!cur || !inHeader) {
        cur = startSection();
        inHeader = true;
      }
      cur.oldPath = headerPath(row);
      cur.newPath = headerPath(rows[i + 1]);
      i += 2;
      continue;
    }
    if (cur === null) {
      if (row.startsWith("@@")) failParse(i + 1);
      i++;
      continue;
    }
    if (inHeader) {
      if (row.startsWith("--- ")) {
        // A --- line in a header must be followed by a +++ line.
        failParse(i + 2);
      }
      if (row.startsWith("@@")) {
        inHeader = false;
        // fall through to hunk parsing below
      } else {
        if (row.startsWith("rename from ")) cur.oldPath = row.slice("rename from ".length).trim();
        else if (row.startsWith("rename to ")) cur.newPath = row.slice("rename to ".length).trim();
        else if (row.startsWith("new file mode")) cur.create = true;
        else if (row.startsWith("deleted file mode")) cur.remove = true;
        i++;
        continue;
      }
    }
    if (row.startsWith("@@")) {
      const m = HUNK_HEAD.exec(row);
      if (!m) failParse(i + 1);
      const hunk: Hunk = { start: Number(m[1]), body: [] };
      i++;
      while (i < rows.length) {
        const b = rows[i];
        if (b.startsWith("diff --git ")) break;
        if (b.startsWith("--- ") && i + 1 < rows.length && rows[i + 1].startsWith("+++ ")) break;
        if (b === "") hunk.body.push({ kind: "ctx", text: "", bare: true });
        else if (b[0] === " ") hunk.body.push({ kind: "ctx", text: b.slice(1) });
        else if (b[0] === "-") hunk.body.push({ kind: "del", text: b.slice(1) });
        else if (b[0] === "+") hunk.body.push({ kind: "add", text: b.slice(1) });
        else if (b[0] === "\\") hunk.body.push({ kind: "bs", text: b });
        else break;
        i++;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1].kind === "ctx" && hunk.body[hunk.body.length - 1].bare) {
        hunk.body.pop();
      }
      cur.hunks.push(hunk);
      continue;
    }
    i++;
  }

  return sections.map((sec) => sectionToEdit(sec));
}

function hunkOldNew(hunk: Hunk): { old: string[]; fresh: ({ at: number } | { text: string })[] } {
  const old: string[] = [];
  const fresh: ({ at: number } | { text: string })[] = [];
  let oldIdx = 0;
  for (const line of hunk.body) {
    if (line.kind === "bs") continue;
    if (line.kind === "ctx") {
      old.push(line.text);
      fresh.push({ at: oldIdx });
      oldIdx++;
    } else if (line.kind === "del") {
      old.push(line.text);
      oldIdx++;
    } else if (line.kind === "add") {
      fresh.push({ text: line.text });
    }
  }
  return { old, fresh };
}

// Does a backslash line follow the hunk's last context or + line?
function noBreakAfter(hunk: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < hunk.body.length; k++) {
    if (hunk.body[k].kind === "ctx" || hunk.body[k].kind === "add") last = k;
  }
  if (last < 0) return false;
  return last + 1 < hunk.body.length && hunk.body[last + 1].kind === "bs";
}

function applyHunks(file: TextFile, hunks: Hunk[], strict: boolean): Failure | null {
  let drift = 0;
  for (const hunk of hunks) {
    const { old, fresh } = hunkOldNew(hunk);
    if (old.length === 0) {
      const at = Math.min(hunk.start + drift, file.rows.length);
      const made = buildFresh(file, at, old, fresh, 0);
      file.rows.splice(at, 0, ...made);
      if (at === file.rows.length - made.length && made.length > 0) {
        // insertion at the end: trailing break follows the \ rule
        if (noBreakAfter(hunk)) file.tail = false;
        else file.tail = true;
      }
      drift += fresh.length - old.length;
      continue;
    }
    const found = locateTier(file.rows, old, strict);
    if (!found) return { code: "no-match", path: "" };
    const target = hunk.start - 1 + drift;
    let best = found.spots[0];
    for (const spot of found.spots) {
      if (Math.abs(spot - target) < Math.abs(best - target)) best = spot;
    }
    const made = buildFresh(file, best, old, fresh, found.tier);
    const reachesEnd = best + old.length === file.rows.length;
    file.rows.splice(best, old.length, ...made);
    if (reachesEnd) file.tail = !noBreakAfter(hunk);
    drift += fresh.length - old.length;
  }
  return null;
}

function sectionToEdit(sec: Section): Edit {
  const isCreate = sec.oldPath === null || sec.create;
  const isDelete = sec.newPath === null || sec.remove;
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const paths = [oldP, newP].filter((p): p is string => p !== null);
  const edit: Edit & { movePair?: { oldP: string; newP: string } } = {
    paths,
    run: (tree, strict) => {
      if (isCreate && newP !== null) {
        if (!safePath(newP)) return { code: "unsafe", path: newP };
        if (tree.has(newP)) return { code: "exists", path: newP };
        const rows: string[] = [];
        let lastPlus: { h: number; b: number } | null = null;
        sec.hunks.forEach((h, hi) => {
          h.body.forEach((line, bi) => {
            if (line.kind === "add") {
              rows.push(line.text);
              lastPlus = { h: hi, b: bi };
            }
          });
        });
        let tail = rows.length > 0;
        if (lastPlus) {
          const h = sec.hunks[lastPlus.h];
          if (lastPlus.b + 1 < h.body.length && h.body[lastPlus.b + 1].kind === "bs") tail = false;
        }
        tree.set(newP, new TextFile("\n", rows, tail));
        return null;
      }
      if (isDelete && oldP !== null) {
        if (!safePath(oldP)) return { code: "unsafe", path: oldP };
        if (!tree.has(oldP)) return { code: "missing", path: oldP };
        tree.delete(oldP);
        return null;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        if (!safePath(oldP)) return { code: "unsafe", path: oldP };
        if (!safePath(newP)) return { code: "unsafe", path: newP };
        const doc = tree.get(oldP);
        if (!doc) return { code: "missing", path: oldP };
        if (tree.has(newP)) return { code: "exists", path: newP };
        const work = doc.clone();
        const bad = applyHunks(work, sec.hunks, strict);
        if (bad) return { code: bad.code, path: oldP };
        tree.delete(oldP);
        tree.set(newP, work);
        return null;
      }
      const p = oldP ?? newP;
      if (p === null) return null;
      if (!safePath(p)) return { code: "unsafe", path: p };
      const doc = tree.get(p);
      if (!doc) return { code: "missing", path: p };
      const work = doc.clone();
      const bad = applyHunks(work, sec.hunks, strict);
      if (bad) return { code: bad.code, path: p };
      tree.set(p, work);
      return null;
    },
  };
  if (oldP !== null && newP !== null && oldP !== newP && !isCreate && !isDelete) {
    edit.movePair = { oldP, newP };
  }
  return edit;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------
function parseSearchReplace(rows: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < rows.length) {
    if (rows[i].replace(/[ \t]+$/, "") !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchAt = i;
    // path: nearest usable line before SEARCH, after the previous block
    let path: string | null = null;
    for (let k = searchAt - 1; k > prevReplaceEnd; k--) {
      const line = rows[k];
      if (blankRow(line)) continue;
      if (line.trimStart().startsWith("```")) continue;
      path = line.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) failParse(searchAt + 1);
    // find ======= then >>>>>>> REPLACE
    let sep = -1;
    let end = -1;
    for (let k = searchAt + 1; k < rows.length; k++) {
      const t = rows[k].replace(/[ \t]+$/, "");
      if (t === "=======") {
        sep = k;
        break;
      }
    }
    if (sep >= 0) {
      for (let k = sep + 1; k < rows.length; k++) {
        if (rows[k].replace(/[ \t]+$/, "") === ">>>>>>> REPLACE") {
          end = k;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) failParse(searchAt + 1);
    const oldRows = rows.slice(searchAt + 1, sep);
    const newRows = rows.slice(sep + 1, end);
    const p = path;
    edits.push({
      paths: [p],
      run: (tree, strict) => {
        if (!safePath(p)) return { code: "unsafe", path: p };
        if (oldRows.length === 0) {
          if (tree.has(p)) return { code: "exists", path: p };
          tree.set(p, new TextFile("\n", [...newRows], newRows.length > 0));
          return null;
        }
        const doc = tree.get(p);
        if (!doc) return { code: "missing", path: p };
        const found = locateTier(doc.rows, oldRows, strict);
        if (!found) return { code: "no-match", path: p };
        if (found.spots.length > 1) return { code: "ambiguous", path: p };
        const at = found.spots[0];
        const fresh = newRows.map((text) => ({ text }));
        const made = buildFresh(doc, at, oldRows, fresh, found.tier);
        const work = doc.clone();
        work.rows.splice(at, oldRows.length, ...made);
        tree.set(p, work);
        return null;
      },
    });
    prevPath = p;
    prevReplaceEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) failParse(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------
type V4aChunk = { anchor: string | null; eof: boolean; body: BodyLine[] };
type V4aSection =
  | { kind: "add"; path: string; rows: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo: string | null; chunks: V4aChunk[] };

function parseV4a(rows: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!blankRow(rows[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) failParse(1);
  if (rows[first].trim() !== "*** Begin Patch") failParse(first + 1);
  if (rows[last].trim() !== "*** End Patch") failParse(rows.length + 1);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const row = rows[i];
    if (blankRow(row)) {
      i++;
      continue;
    }
    if (row.startsWith("*** Add File: ")) {
      const path = row.slice("*** Add File: ".length).trim();
      const made: string[] = [];
      i++;
      while (i < last) {
        const line = rows[i];
        if (line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ") || line.trim() === "*** End Patch") break;
        if (line.startsWith("+")) made.push(line.slice(1));
        else if (line === "") made.push("");
        else failParse(i + 1);
        i++;
      }
      while (made.length > 0 && made[made.length - 1] === "") made.pop();
      sections.push({ kind: "add", path, rows: made });
      continue;
    }
    if (row.startsWith("*** Delete File: ")) {
      const path = row.slice("*** Delete File: ".length).trim();
      sections.push({ kind: "delete", path });
      i++;
      continue;
    }
    if (row.startsWith("*** Update File: ")) {
      const path = row.slice("*** Update File: ".length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      while (i < last && blankRow(rows[i])) i++;
      if (i < last && rows[i].startsWith("*** Move to: ")) {
        moveTo = rows[i].slice("*** Move to: ".length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let seenChunk = false;
      const closeChunk = () => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const line = rows[i];
        if (line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ") || line.trim() === "*** End Patch") break;
        if (line.startsWith("@@")) {
          closeChunk();
          cur = { anchor: line.slice(2).trim() === "" ? null : line.slice(2).trim(), eof: false, body: [] };
          seenChunk = true;
          i++;
          continue;
        }
        if (line.trim() === "*** End of File") {
          if (!cur) failParse(i + 1);
          cur.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (line === "" || line[0] === " " || line[0] === "-" || line[0] === "+") {
          if (!cur) {
            if (seenChunk) failParse(i + 1);
            cur = { anchor: null, eof: false, body: [] };
            seenChunk = true;
          }
          if (line === "") cur.body.push({ kind: "ctx", text: "" });
          else if (line[0] === " ") cur.body.push({ kind: "ctx", text: line.slice(1) });
          else if (line[0] === "-") cur.body.push({ kind: "del", text: line.slice(1) });
          else cur.body.push({ kind: "add", text: line.slice(1) });
          i++;
          continue;
        }
        if (blankRow(line)) {
          // blank lines between chunks are body lines of an open chunk, or
          // ignored when no chunk is open yet
          if (cur) {
            cur.body.push({ kind: "ctx", text: "" });
            i++;
            continue;
          }
          i++;
          continue;
        }
        failParse(i + 1);
      }
      closeChunk();
      // blank lines at the end of the section are not part of it: drop
      // trailing empty context rows from the last chunk
      if (chunks.length > 0) {
        const tailChunk = chunks[chunks.length - 1];
        while (tailChunk.body.length > 0) {
          const b = tailChunk.body[tailChunk.body.length - 1];
          if (b.kind === "ctx" && b.text.trim() === "") tailChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) failParse(updateLine);
      sections.push({ kind: "update", path, moveTo, chunks });
      continue;
    }
    failParse(i + 1);
  }
  if (sections.length === 0) failParse(1);
  return sections.map((sec) => v4aToEdit(sec));
}

function v4aToEdit(sec: V4aSection): Edit {
  if (sec.kind === "add") {
    return {
      paths: [sec.path],
      run: (tree) => {
        if (!safePath(sec.path)) return { code: "unsafe", path: sec.path };
        if (tree.has(sec.path)) return { code: "exists", path: sec.path };
        tree.set(sec.path, new TextFile("\n", [...sec.rows], sec.rows.length > 0));
        return null;
      },
    };
  }
  if (sec.kind === "delete") {
    return {
      paths: [sec.path],
      run: (tree) => {
        if (!safePath(sec.path)) return { code: "unsafe", path: sec.path };
        if (!tree.has(sec.path)) return { code: "missing", path: sec.path };
        tree.delete(sec.path);
        return null;
      },
    };
  }
  const paths = sec.moveTo === null ? [sec.path] : [sec.path, sec.moveTo];
  const edit: Edit & { movePair?: { oldP: string; newP: string } } = {
    paths,
    run: (tree, strict) => {
      if (!safePath(sec.path)) return { code: "unsafe", path: sec.path };
      if (sec.moveTo !== null && !safePath(sec.moveTo)) return { code: "unsafe", path: sec.moveTo };
      const doc = tree.get(sec.path);
      if (!doc) return { code: "missing", path: sec.path };
      if (sec.moveTo !== null && tree.has(sec.moveTo)) return { code: "exists", path: sec.moveTo };
      const work = doc.clone();
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          let foundAt = -1;
          for (const tier of tiersToTry(strict)) {
            for (let k = cursor; k < work.rows.length; k++) {
              if (rowsEqualAt(work.rows[k], chunk.anchor, tier)) {
                foundAt = k;
                break;
              }
            }
            if (foundAt >= 0) break;
          }
          if (foundAt < 0) return { code: "no-match", path: sec.path };
          cursor = foundAt + 1;
        }
        const { old, fresh } = hunkOldNew({ start: 0, body: chunk.body });
        if (old.length === 0) {
          const at = chunk.eof ? work.rows.length : cursor;
          const made = buildFresh(work, at, old, fresh, 0);
          work.rows.splice(at, 0, ...made);
          cursor = at + made.length;
          continue;
        }
        let picked: { tier: number; at: number } | null = null;
        for (const tier of tiersToTry(strict)) {
          const spots = findSpots(work.rows, old, tier, cursor);
          const good = chunk.eof ? spots.filter((s) => s + old.length === work.rows.length) : spots;
          if (good.length > 0) {
            picked = { tier, at: good[0] };
            break;
          }
        }
        if (!picked) return { code: "no-match", path: sec.path };
        const made = buildFresh(work, picked.at, old, fresh, picked.tier);
        work.rows.splice(picked.at, old.length, ...made);
        cursor = picked.at + made.length;
      }
      if (sec.moveTo !== null) {
        tree.delete(sec.path);
        tree.set(sec.moveTo, work);
      } else {
        tree.set(sec.path, work);
      }
      return null;
    },
  };
  if (sec.moveTo !== null) edit.movePair = { oldP: sec.path, newP: sec.moveTo };
  return edit;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------
type JsonOp =
  | { kind: "create"; path: string; text: string }
  | { kind: "replace"; path: string; oldText: string; newText: string }
  | { kind: "insert"; path: string; at: number; text: string };

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function jsonOpFrom(obj: unknown, badLine: number): JsonOp {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) failParse(badLine);
  const rec = obj as Record<string, unknown>;
  const path = asString(rec.path);
  const cmd = asString(rec.command);
  if (path === null || cmd === null) failParse(badLine);
  if (cmd === "create") {
    const text = asString(rec.file_text);
    if (text === null) failParse(badLine);
    return { kind: "create", path, text };
  }
  if (cmd === "str_replace") {
    const oldText = asString(rec.old_str);
    const newText = rec.new_str === undefined ? "" : asString(rec.new_str);
    if (oldText === null || oldText === "" || newText === null) failParse(badLine);
    return { kind: "replace", path, oldText, newText };
  }
  if (cmd === "insert") {
    const at = rec.insert_line;
    const text = asString(rec.new_str);
    if (typeof at !== "number" || !Number.isInteger(at) || text === null) failParse(badLine);
    return { kind: "insert", path, at, text };
  }
  failParse(badLine);
}

function parseJson(rows: string[]): Edit[] {
  const ops: JsonOp[] = [];
  let first = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!blankRow(rows[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) failParse(1);
  if (rows[first].trimStart().startsWith("[")) {
    const startLine = first + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rows.slice(first).join("\n"));
    } catch {
      failParse(startLine);
    }
    if (!Array.isArray(parsed)) failParse(startLine);
    for (const item of parsed) ops.push(jsonOpFrom(item, startLine));
  } else {
    for (let i = 0; i < rows.length; i++) {
      if (blankRow(rows[i])) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rows[i]);
      } catch {
        failParse(i + 1);
      }
      ops.push(jsonOpFrom(parsed, i + 1));
    }
  }
  if (ops.length === 0) failParse(1);
  return ops.map((op) => jsonOpToEdit(op));
}

function jsonOpToEdit(op: JsonOp): Edit {
  return {
    paths: [op.path],
    run: (tree) => {
      if (!safePath(op.path)) return { code: "unsafe", path: op.path };
      if (op.kind === "create") {
        if (tree.has(op.path)) return { code: "exists", path: op.path };
        tree.set(op.path, TextFile.fromText(op.text));
        return null;
      }
      const doc = tree.get(op.path);
      if (!doc) return { code: "missing", path: op.path };
      if (op.kind === "replace") {
        let hay = doc.render();
        let needle = op.oldText;
        let sub = op.newText;
        const crlf = doc.brk === "\r\n";
        if (crlf) {
          hay = hay.replace(/\r\n/g, "\n");
          needle = needle.replace(/\r\n/g, "\n");
          sub = sub.replace(/\r\n/g, "\n");
        }
        let count = 0;
        let pos = 0;
        let firstAt = -1;
        while (true) {
          const at = hay.indexOf(needle, pos);
          if (at < 0) break;
          if (firstAt < 0) firstAt = at;
          count++;
          pos = at + 1;
        }
        if (count === 0) return { code: "no-match", path: op.path };
        if (count > 1) return { code: "ambiguous", path: op.path };
        const done = hay.slice(0, firstAt) + sub + hay.slice(firstAt + needle.length);
        tree.set(op.path, TextFile.fromText(crlf ? done.replace(/\n/g, "\r\n") : done));
        return null;
      }
      // insert
      if (op.at < 0 || op.at > doc.rows.length) return { code: "no-match", path: op.path };
      const added = patchRows(op.text);
      const work = doc.clone();
      work.rows.splice(op.at, 0, ...added);
      tree.set(op.path, work);
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Driver: load the tree, run the edits, report, write (SPEC sections 2, 10)
// ---------------------------------------------------------------------------
function byteLess(a: string, b: string): number {
  const x = Buffer.from(a, "utf-8");
  const y = Buffer.from(b, "utf-8");
  const n = Math.min(x.length, y.length);
  for (let k = 0; k < n; k++) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  return x.length - y.length;
}

function loadTree(): Tree {
  const tree: Tree = new Map();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        tree.set(relative(process.cwd(), full), TextFile.fromText(readFileSync(full, "utf-8")));
      }
    }
  };
  walk(process.cwd());
  return tree;
}

function main(): void {
  const args = readArgs(process.argv.slice(2));
  const text = readPatchText(args.patch);
  const rows = patchRows(text);
  const kind = args.format === "auto" ? detectKind(rows) : args.format;
  let edits: Edit[];
  if (kind === "unified") edits = parseUnified(rows);
  else if (kind === "search-replace") edits = parseSearchReplace(rows);
  else if (kind === "v4a") edits = parseV4a(rows);
  else edits = parseJson(rows);

  const before = loadTree();
  const tree: Tree = new Map();
  for (const [p, f] of before) tree.set(p, f.clone());

  const failures: Failure[] = [];
  for (const edit of edits) {
    const bad = edit.run(tree, args.strict);
    if (bad) failures.push(bad);
  }
  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(out.join("\n") + "\n");
    process.exit(1);
  }

  // Work out what changed, against the tree as it was.
  const allPaths = new Set<string>([...before.keys(), ...tree.keys()]);
  const lines: { line: string; sort: string }[] = [];
  for (const p of allPaths) {
    const was = before.get(p);
    const now = tree.get(p);
    if (was === undefined && now !== undefined) lines.push({ line: `A ${p}`, sort: p });
    else if (was !== undefined && now === undefined) lines.push({ line: `D ${p}`, sort: p });
    else if (was !== undefined && now !== undefined && was.render() !== now.render()) {
      lines.push({ line: `M ${p}`, sort: p });
    }
  }
  // Fold D+A pairs of successful moves into R lines, sorted by the new path.
  const movePairs: { oldP: string; newP: string }[] = [];
  for (const edit of edits) {
    const pair = (edit as Edit & { movePair?: { oldP: string; newP: string } }).movePair;
    if (pair) movePairs.push(pair);
  }
  for (const { oldP, newP } of movePairs) {
    const oldWas = before.has(oldP);
    const oldNow = tree.has(oldP);
    const newWas = before.has(newP);
    const newNow = tree.has(newP);
    if (oldWas && !oldNow && !newWas && newNow) {
      for (let k = lines.length - 1; k >= 0; k--) {
        if (lines[k].line === `D ${oldP}` || lines[k].line === `A ${newP}`) lines.splice(k, 1);
      }
      lines.push({ line: `R ${oldP} -> ${newP}`, sort: newP });
    }
  }
  lines.sort((a, b) => byteLess(a.sort, b.sort));
  const out = lines.map((l) => l.line);
  out.push(`ok: ${lines.length} file${lines.length === 1 ? "" : "s"}`);

  if (!args.check) {
    for (const p of allPaths) {
      const now = tree.get(p);
      const was = before.get(p);
      if (now === undefined && was !== undefined) {
        try {
          unlinkSync(p);
        } catch {
          // already gone
        }
      } else if (now !== undefined && (was === undefined || was.render() !== now.render())) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now.render(), "utf-8");
      }
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}

main();
