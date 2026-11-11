import { asString, mapPath } from "./paths.js";
import { randomUUID } from "node:crypto";

type Cell = {
  id?: string;
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata?: object;
  outputs?: unknown[];
  execution_count?: number | null;
};
type Notebook = { cells: Cell[]; nbformat?: number; nbformat_minor?: number };

const cellId = (cell: Cell, index: number) => cell.id ?? `cell-${index}`;
const asLines = (source: string) => source.split(/(?<=\n)/);

export async function notebookEditTool(cwd: string, tuiRoot: string | undefined, input: Record<string, unknown>, extraDirs: string[] = []) {
  const path = mapPath(cwd, tuiRoot, asString(input.notebook_path), extraDirs);
  if (!path.endsWith(".ipynb")) throw new Error("File must be a Jupyter notebook (.ipynb file). For editing other file types, use the Edit tool.");
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Notebook file does not exist: ${path}`);
  const original_file = await file.text();
  let nb: Notebook;
  try {
    nb = JSON.parse(original_file);
  } catch {
    throw new Error("Notebook is not valid JSON.");
  }
  const edit_mode = asString(input.edit_mode, "replace") || "replace";
  const cell_id = typeof input.cell_id === "string" ? input.cell_id : undefined;
  const new_source = asString(input.new_source);
  const requestedType = input.cell_type === "code" || input.cell_type === "markdown" ? input.cell_type : undefined;

  let index = -1;
  if (cell_id !== undefined) {
    index = nb.cells.findIndex((c, i) => cellId(c, i) === cell_id);
    if (index === -1) throw new Error(`Cell with ID "${cell_id}" not found in notebook.`);
  } else if (edit_mode !== "insert") {
    throw new Error(`cell_id is required for edit_mode "${edit_mode}".`);
  }

  let old_source: string | undefined;
  if (edit_mode === "delete") {
    old_source = [nb.cells[index]!.source].flat().join("");
    nb.cells.splice(index, 1);
  } else if (edit_mode === "insert") {
    if (!requestedType) throw new Error('cell_type is required when using edit_mode "insert".');
    const withIds = (nb.nbformat ?? 4) > 4 || ((nb.nbformat ?? 4) === 4 && (nb.nbformat_minor ?? 0) >= 5);
    const cell: Cell = {
      ...(withIds ? { id: randomUUID().slice(0, 8) } : {}),
      cell_type: requestedType,
      metadata: {},
      source: asLines(new_source),
      ...(requestedType === "code" ? { execution_count: null, outputs: [] } : {}),
    };
    nb.cells.splice(index + 1, 0, cell);
    index += 1;
  } else {
    const cell = nb.cells[index]!;
    old_source = [cell.source].flat().join("");
    cell.source = asLines(new_source);
    if (requestedType) cell.cell_type = requestedType;
    if (cell.cell_type === "code") {
      cell.execution_count = null;
      cell.outputs = [];
    } else {
      delete cell.execution_count;
      delete cell.outputs;
    }
  }

  const updated_file = `${JSON.stringify(nb, null, 1)}\n`;
  await Bun.write(path, updated_file);
  const edited = edit_mode === "delete" ? undefined : nb.cells[index];
  return {
    new_source,
    old_source,
    cell_id: edit_mode === "delete" ? cell_id : edited ? cellId(edited, index) : cell_id,
    cell_type: edited?.cell_type === "markdown" ? "markdown" as const : "code" as const,
    language: "python",
    edit_mode,
    notebook_path: path,
    original_file,
    updated_file,
  };
}
