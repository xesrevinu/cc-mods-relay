export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

export function structuredPatch(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return [];
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return [
    {
      oldStart: 1,
      oldLines: oldLines.length,
      newStart: 1,
      newLines: newLines.length,
      lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
    },
  ];
}
