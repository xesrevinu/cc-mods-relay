export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

const CONTEXT = 3;
const MAX_LCS_CELLS = 400_000;

type Op = { kind: "eq" | "del" | "add"; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ kind: "add", line }));
  if (m === 0) return a.map((line) => ({ kind: "del", line }));
  if (n * m > MAX_LCS_CELLS) {
    return [
      ...a.map((line): Op => ({ kind: "del", line })),
      ...b.map((line): Op => ({ kind: "add", line })),
    ];
  }
  const cols = m + 1;
  const dp = new Int32Array((n + 1) * cols);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i]!;
    const row = i * cols;
    const nextRow = (i + 1) * cols;
    for (let j = m - 1; j >= 0; j--) {
      if (ai === b[j]!) {
        dp[row + j] = dp[nextRow + j + 1]! + 1;
      } else {
        const down = dp[nextRow + j]!;
        const right = dp[row + j + 1]!;
        dp[row + j] = down >= right ? down : right;
      }
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]! === b[j]!) {
      ops.push({ kind: "eq", line: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + j + 1]!) {
      ops.push({ kind: "del", line: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", line: b[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: "del", line: a[i++]! });
  while (j < m) ops.push({ kind: "add", line: b[j++]! });
  return ops;
}

function splitFileLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Contextual unified-diff hunks matching native Claude Code Edit/Write structuredPatch. */
export function structuredPatch(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return [];
  const oldLines = splitFileLines(oldText);
  const newLines = splitFileLines(newText);
  if (oldLines.length === newLines.length && oldLines.every((l, i) => l === newLines[i])) {
    // Only trailing newline differed.
    const lastOld = oldLines.at(-1) ?? "";
    const oldStart = Math.max(1, oldLines.length);
    return [{
      oldStart,
      oldLines: oldLines.length > 0 ? 1 : 0,
      newStart: oldStart,
      newLines: newLines.length > 0 ? 1 : 0,
      lines: [
        ...(oldLines.length > 0 ? [`-${lastOld}`] : []),
        ...(oldText.endsWith("\n") ? [] : ["\\ No newline at end of file"]),
        ...(newLines.length > 0 ? [`+${lastOld}`] : []),
        ...(newText.endsWith("\n") ? [] : ["\\ No newline at end of file"]),
      ],
    }];
  }

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  const allOps: Op[] = [
    ...oldLines.slice(0, prefix).map((line): Op => ({ kind: "eq", line })),
    ...diffOps(midOld, midNew),
    ...oldLines.slice(oldLines.length - suffix).map((line): Op => ({ kind: "eq", line })),
  ];

  // Annotate 1-based line numbers for each op, then group changed ranges with CONTEXT lines.
  const entries: { op: Op; oldNo: number; newNo: number }[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of allOps) {
    entries.push({ op, oldNo, newNo });
    if (op.kind !== "add") oldNo += 1;
    if (op.kind !== "del") newNo += 1;
  }

  const hunks: Hunk[] = [];
  let idx = 0;
  while (idx < entries.length) {
    if (entries[idx]!.op.kind === "eq") {
      idx += 1;
      continue;
    }
    const start = Math.max(0, idx - CONTEXT);
    let end = idx;
    while (end < entries.length) {
      if (entries[end]!.op.kind !== "eq") {
        end += 1;
        continue;
      }
      let eqRun = 0;
      while (end + eqRun < entries.length && entries[end + eqRun]!.op.kind === "eq") eqRun += 1;
      if (end + eqRun < entries.length && eqRun <= CONTEXT * 2) {
        end += eqRun;
      } else {
        end += Math.min(CONTEXT, eqRun);
        break;
      }
    }
    const slice = entries.slice(start, end);
    let oCount = 0;
    let nCount = 0;
    const lines: string[] = [];
    for (const e of slice) {
      if (e.op.kind === "eq") {
        oCount += 1;
        nCount += 1;
        lines.push(` ${e.op.line}`);
      } else if (e.op.kind === "del") {
        oCount += 1;
        lines.push(`-${e.op.line}`);
      } else {
        nCount += 1;
        lines.push(`+${e.op.line}`);
      }
    }
    const first = slice[0]!;
    hunks.push({
      oldStart: oCount === 0 ? Math.max(0, first.oldNo - 1) : first.oldNo,
      oldLines: oCount,
      newStart: nCount === 0 ? Math.max(0, first.newNo - 1) : first.newNo,
      newLines: nCount,
      lines,
    });
    idx = end;
  }
  return hunks;
}
