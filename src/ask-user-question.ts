export type AskOption = { label: string; description?: string };
export type AskQuestion = {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
};

const key = (index: number) => `q${index}`;

export function questionForm(questions: AskQuestion[]) {
  const properties: Record<string, unknown> = {};
  questions.forEach((q, i) => {
    const options = q.options.map((o) => ({ const: o.label, title: o.label, description: o.description }));
    const common = { title: q.header ?? q.question, description: q.question };
    properties[key(i)] = q.multiSelect
      ? { ...common, type: "array", minItems: 1, items: { anyOf: options } }
      : { ...common, type: "string", oneOf: options };
  });
  return { type: "object", properties, required: questions.map((_, i) => key(i)) };
}

export function formAnswers(
  questions: AskQuestion[],
  content: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const value = content?.[key(i)] ?? (q.header ? content?.[q.header] : undefined) ?? content?.[q.question];
    if (value === undefined) return;
    answers[q.question] = Array.isArray(value) ? value.join(", ") : String(value);
  });
  return answers;
}

export function asAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const q = row as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof q.question !== "string" || !Array.isArray(q.options)) return [];
    const options = q.options.flatMap((opt) => {
      if (!opt || typeof opt !== "object") return [];
      const o = opt as { label?: unknown; description?: unknown };
      return typeof o.label === "string" ? [{ label: o.label, description: typeof o.description === "string" ? o.description : undefined }] : [];
    });
    return [{
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      options,
      multiSelect: q.multiSelect === true,
    }];
  });
}
