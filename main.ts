// mend: one patch tool for every AI edit format, as SPEC.md specifies. It reads a patch in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the
// first of three matching tiers, and writes every change or none, printing what it changed or why it
// failed. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** The patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path: not empty, no leading /, no \, no empty, . or .. segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------- files as lines ----------

/** A file read as its lines, its own line break, and whether it ends with that break. */
interface Model {
  lines: string[];
  br: string;
  final: boolean;
}

function parseModel(text: string): Model {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function writeModel(m: Model): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---------- matching (SPEC.md section 5) ----------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position at or after `from` where O's lines match the file's lines at `tier`; may overlap. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!eqTier(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier at which O occurs at or after `from`, with its positions there. When `eof` is set, only
 * occurrences that end at the file's last line are eligible, at every tier.
 */
function findTier(lines: string[], O: string[], strict: boolean, from: number, eof = false): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let at = occurrences(lines, O, t, from);
    if (eof) at = at.filter((p) => p + O.length === lines.length);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of a hunk or chunk body: context, old, new, a `\` note, or an empty line read as context. */
interface Entry {
  k: ' ' | '-' | '+' | '\\' | 'e';
  text: string;
}

function oldLines(entries: Entry[]): string[] {
  return entries.filter((e) => e.k === ' ' || e.k === '-' || e.k === 'e').map((e) => e.text);
}

/**
 * The lines a matched hunk or chunk writes: a context line is the file's own matched line, a `+` line is
 * written as it is, except at tier 2, where a `+` line that starts with O's first line's indentation gets
 * the file's first matched line's indentation instead.
 */
function buildSeg(entries: Entry[], fileLines: string[], pos: number, tier: number): string[] {
  const O = oldLines(entries);
  let leadF = '';
  let leadP = '';
  if (tier === 2 && O.length > 0) {
    leadF = /^[ \t]*/.exec(fileLines[pos]!)![0];
    leadP = /^[ \t]*/.exec(O[0]!)![0];
  }
  const seg: string[] = [];
  let oi = 0;
  for (const e of entries) {
    if (e.k === ' ' || e.k === 'e') {
      seg.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (e.k === '-') {
      oi += 1;
    } else if (e.k === '+') {
      let line = e.text;
      if (tier === 2 && line.trim() !== '' && line.startsWith(leadP)) line = leadF + line.slice(leadP.length);
      seg.push(line);
    }
  }
  return seg;
}

// ---------- the tree ----------

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

/** One run: the tree the edits work on, and the moves that succeeded, for the `R` output lines. */
class Run {
  readonly tree = new Tree();
  readonly moves: [string, string][] = [];
}

type Edit = (run: Run) => void;

// ---------- format detection (section 4) ----------

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

// ---------- unified diffs (section 6) ----------

interface Hunk {
  a: number;
  entries: Entry[];
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  minus?: string;
  plus?: string;
  renameFrom?: string;
  renameTo?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a --- or +++ line names: after the four characters, up to the first tab, spaces removed, a/ or b/ stripped. */
function headerPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/** Apply one section's hunks, in order, to a file model; a failure throws and changes nothing. */
function applyHunks(model: Model, hunks: Hunk[], strict: boolean, errPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const O = oldLines(h.entries);
    const nLen = h.entries.filter((e) => e.k === ' ' || e.k === 'e' || e.k === '+').length;
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const seg = buildSeg(h.entries, model.lines, at, 0);
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...seg);
      if (atEnd && seg.length > 0) model.final = !slashAfter(h.entries);
    } else {
      const found = findTier(model.lines, O, strict, 0);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      for (const p of found.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const seg = buildSeg(h.entries, model.lines, pos, found.tier);
      const runsToEnd = pos + O.length === model.lines.length;
      model.lines.splice(pos, O.length, ...seg);
      if (runsToEnd) {
        if (h.entries.some((e) => e.k === ' ' || e.k === 'e' || e.k === '+')) model.final = !slashAfter(h.entries);
        else model.final = model.lines.length > 0;
      }
    }
    d += nLen - O.length;
  }
}

/** Whether a `\` line immediately follows the hunk's last context or `+` line. */
function slashAfter(entries: Entry[]): boolean {
  let last = -1;
  entries.forEach((e, i) => {
    if (e.k === ' ' || e.k === 'e' || e.k === '+') last = i;
  });
  return last >= 0 && entries[last + 1]?.k === '\\';
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let state: 'out' | 'header' | 'body' | 'between' = 'out';
  let hunk: Hunk | null = null;

  const startSection = (diffOld?: string, diffNew?: string): Section => {
    const s: Section = { create: false, del: false, hunks: [] };
    if (diffOld !== undefined) s.diffOld = diffOld;
    if (diffNew !== undefined) s.diffNew = diffNew;
    sections.push(s);
    return s;
  };
  const finishHunk = (): void => {
    if (hunk !== null) {
      while (hunk.entries.length > 0 && hunk.entries[hunk.entries.length - 1]!.k === 'e') hunk.entries.pop();
      sec!.hunks.push(hunk);
      hunk = null;
    }
  };
  const startHunk = (line: string, ln: number): Hunk => {
    const m = HUNK_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${ln}`);
    return { a: parseInt(m[1]!, 10), entries: [] };
  };
  const diffPaths = (line: string, ln: number): [string, string] => {
    const m = /^a\/(.+) b\/(.+)$/.exec(line.slice(11));
    if (m === null) throw new Exit2(`error: parse ${ln}`);
    return [m[1]!, m[2]!];
  };
  const setPair = (s: Section, minus: string, plus: string): void => {
    s.minus = headerPath(minus);
    s.plus = headerPath(plus);
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    const ln = idx + 1;
    const next = lines[idx + 1];
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        finishHunk();
        const [x, y] = diffPaths(line, ln);
        sec = startSection(x, y);
        state = 'header';
        continue;
      }
      if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
        finishHunk();
        sec = startSection();
        setPair(sec, line, next);
        idx += 1;
        state = 'header';
        continue;
      }
      if (line.startsWith('@@')) {
        finishHunk();
        hunk = startHunk(line, ln);
        continue;
      }
      if (line === '') {
        hunk!.entries.push({ k: 'e', text: '' });
        continue;
      }
      const c = line[0]!;
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        hunk!.entries.push({ k: c as Entry['k'], text: line.slice(1) });
        continue;
      }
      finishHunk();
      state = 'between';
    }
    if (state === 'between') {
      if (line.startsWith('diff --git ')) {
        const [x, y] = diffPaths(line, ln);
        sec = startSection(x, y);
        state = 'header';
      } else if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
        sec = startSection();
        setPair(sec, line, next);
        idx += 1;
        state = 'header';
      } else if (line.startsWith('@@')) {
        hunk = startHunk(line, ln);
        state = 'body';
      }
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        const [x, y] = diffPaths(line, ln);
        sec = startSection(x, y);
        continue;
      }
      if (line.startsWith('--- ')) {
        if (next !== undefined && next.startsWith('+++ ')) {
          setPair(sec!, line, next);
          idx += 1;
          continue;
        }
        throw new Exit2(`error: parse ${ln + 1}`);
      }
      if (line.startsWith('@@')) {
        hunk = startHunk(line, ln);
        state = 'body';
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec!.renameFrom = line.slice(12).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec!.renameTo = line.slice(10).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec!.create = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec!.del = true;
        continue;
      }
      continue;
    }
    // state 'out': prose and code fences are ignored; a section starts at a diff --git line or a ---/+++ pair.
    if (line.startsWith('diff --git ')) {
      const [x, y] = diffPaths(line, ln);
      sec = startSection(x, y);
      state = 'header';
    } else if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      sec = startSection();
      setPair(sec, line, next);
      idx += 1;
      state = 'header';
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  finishHunk();
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldRaw = sec.minus ?? sec.renameFrom ?? sec.diffOld;
  const newRaw = sec.plus ?? sec.renameTo ?? sec.diffNew;
  const oldPath = oldRaw === undefined || oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === undefined || newRaw === '/dev/null' ? null : newRaw;
  const isCreate = sec.create || oldRaw === '/dev/null';
  const isDelete = sec.del || newRaw === '/dev/null';
  if (isCreate) {
    // The path the edit names, as written; /dev/null itself is not a safe path, so a section that
    // creates it fails unsafe rather than naming no path at all.
    const p = newPath ?? newRaw ?? '';
    return (run) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (run.tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        let lastPlus = -1;
        h.entries.forEach((e, i) => {
          if (e.k === '+') {
            plus.push(e.text);
            lastPlus = i;
          }
        });
        if (lastPlus >= 0) noBreak = h.entries[lastPlus + 1]?.k === '\\';
      }
      run.tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = oldPath ?? oldRaw ?? '';
    return (run) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (run.tree.get(p) === null) throw new Fail('missing', p);
      run.tree.now.set(p, null);
    };
  }
  const o = oldPath ?? oldRaw ?? '';
  const n = newPath ?? newRaw ?? '';
  const isMove = o !== n;
  return (run) => {
    if (!safe(o)) throw new Fail('unsafe', o);
    if (isMove && !safe(n)) throw new Fail('unsafe', n);
    const before = run.tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (isMove && run.tree.get(n) !== null) throw new Fail('exists', n);
    const model = parseModel(before);
    applyHunks(model, sec.hunks, strict, o);
    const text = writeModel(model);
    if (isMove) {
      run.tree.now.set(o, null);
      run.tree.now.set(n, text);
      run.moves.push([o, n]);
    } else {
      run.tree.now.set(o, text);
    }
  };
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLn = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= regionStart; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLn}`);
      path = prevPath;
    }
    let sep = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLn}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLn}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    regionStart = end + 1;
    i = end + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (run) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (run.tree.get(path) !== null) throw new Fail('exists', path);
      run.tree.now.set(path, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const before = run.tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseModel(before);
    const found = findTier(model.lines, oldL, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const entries: Entry[] = [
      ...oldL.map((t) => ({ k: '-' as const, text: t })),
      ...newL.map((t) => ({ k: '+' as const, text: t })),
    ];
    const seg = buildSeg(entries, model.lines, pos, found.tier);
    model.lines.splice(pos, oldL.length, ...seg);
    run.tree.now.set(path, writeModel(model));
  };
}

// ---------- V4A patches (section 8) ----------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  entries: Entry[];
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface RawSec {
    kind: 'add' | 'del' | 'upd';
    path: string;
    ln: number;
    body: { line: string; ln: number }[];
  }
  const secs: RawSec[] = [];
  let cur: RawSec | null = null;
  const starts: [string, RawSec['kind']][] = [
    ['*** Add File:', 'add'],
    ['*** Delete File:', 'del'],
    ['*** Update File:', 'upd'],
  ];
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const ln = i + 1;
    let started: RawSec | null = null;
    for (const [prefix, kind] of starts) {
      if (line.startsWith(prefix)) {
        started = { kind, path: line.slice(prefix.length).trim(), ln, body: [] };
        break;
      }
    }
    if (started !== null) {
      secs.push(started);
      cur = started;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${ln}`);
    }
    cur.body.push({ line, ln });
  }

  const edits: Edit[] = [];
  for (const s of secs) {
    const body = [...s.body];
    while (body.length > 0 && blank(body[body.length - 1]!.line)) body.pop();
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) fileLines.push(b.line.slice(1));
        else if (b.line === '') fileLines.push('');
        else throw new Exit2(`error: parse ${b.ln}`);
      }
      edits.push(addEdit(s.path, fileLines));
    } else if (s.kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.ln}`);
      edits.push(deleteEdit(s.path));
    } else {
      edits.push(updateEdit(s, body, strict));
    }
  }
  return edits;
}

function addEdit(path: string, fileLines: string[]): Edit {
  return (run) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (run.tree.get(path) !== null) throw new Fail('exists', path);
    run.tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function deleteEdit(path: string): Edit {
  return (run) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (run.tree.get(path) === null) throw new Fail('missing', path);
    run.tree.now.set(path, null);
  };
}

function updateEdit(s: { path: string; ln: number }, body: { line: string; ln: number }[], strict: boolean): Edit {
  const path = s.path;
  let moveTo: string | null = null;
  let bi = 0;
  if (body.length > 0 && body[0]!.line.startsWith('*** Move to:')) {
    moveTo = body[0]!.line.slice('*** Move to:'.length).trim();
    bi = 1;
  }
  const chunks: Chunk[] = [];
  let chunk: Chunk | null = null;
  for (; bi < body.length; bi += 1) {
    const { line, ln } = body[bi]!;
    if (line.startsWith('@@')) {
      chunk = { anchor: line.slice(2).trim() || null, eof: false, entries: [] };
      chunks.push(chunk);
    } else if (line === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${ln}`);
      chunk.eof = true;
      chunk = null;
    } else if (line.startsWith('*** Move to:')) {
      throw new Exit2(`error: parse ${ln}`);
    } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (chunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        chunk = { anchor: null, eof: false, entries: [] };
        chunks.push(chunk);
      }
      chunk.entries.push({ k: line === '' ? ' ' : (line[0] as Entry['k']), text: line === '' ? '' : line.slice(1) });
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.ln}`);
  const to = moveTo;
  return (run) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const before = run.tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (to !== null && run.tree.get(to) !== null) throw new Fail('exists', to);
    const model = parseModel(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let ai = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let i = cursor; i < model.lines.length; i += 1) {
            if (eqTier(model.lines[i]!, ch.anchor, t)) {
              ai = i;
              break;
            }
          }
          if (ai >= 0) break;
        }
        if (ai < 0) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      const O = oldLines(ch.entries);
      if (O.length === 0) {
        const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const seg = buildSeg(ch.entries, model.lines, at, 0);
        model.lines.splice(at, 0, ...seg);
        cursor = at + seg.length;
      } else {
        const found = findTier(model.lines, O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.at[0]!;
        const seg = buildSeg(ch.entries, model.lines, pos, found.tier);
        model.lines.splice(pos, O.length, ...seg);
        cursor = pos + seg.length;
      }
    }
    const text = writeModel(model);
    if (to !== null) {
      run.tree.now.set(path, null);
      run.tree.now.set(to, text);
      run.moves.push([path, to]);
    } else {
      run.tree.now.set(path, text);
    }
  };
}

// ---------- JSON edits (section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (run: Run): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = run.tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (run) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (run.tree.get(p) !== null) throw new Fail('exists', p);
      run.tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (run) => {
      const before = exists(run);
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
      run.tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (run) => {
      const before = exists(run);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const fin = before !== '' && before.endsWith(br);
      if (fin) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      run.tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (fin ? br : ''));
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

// ---------- the run (sections 1, 2 and 10) ----------

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const runState = new Run();
  const tree = runState.tree;
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = runState.moves.length;
    try {
      edit(runState);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      runState.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    byPath.set(p, row);
    rows.push(row);
  }
  for (const [o, n] of runState.moves) {
    const del = byPath.get(o);
    const add = byPath.get(n);
    if (del !== undefined && add !== undefined && del.text.startsWith('D ') && add.text.startsWith('A ')) {
      rows.splice(rows.indexOf(del), 1);
      byPath.delete(o);
      add.text = `R ${o} -> ${n}`;
    }
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
