import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk/unstable";

export interface ElicitationDecision {
  decision: "deny";
  reason: string;
}

export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export interface ElicitationClient {
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

export function buildElicitationRequest(
  toolUseId: string,
  sessionId: string,
  toolInput: AskUserQuestionInput,
): CreateElicitationRequest {
  const properties: Record<string, { type: "string"; title: string; enum: string[] }> = {};
  const required: string[] = [];

  for (const q of toolInput.questions) {
    properties[q.header] = {
      type: "string",
      title: q.question,
      enum: q.options.map((o) => o.label),
    };
    required.push(q.header);
  }

  const message =
    toolInput.questions.length === 1
      ? `Please answer: ${toolInput.questions[0]?.question ?? "the question below"}`
      : `Please answer the following ${toolInput.questions.length} question(s).`;

  return {
    mode: "form",
    message,
    sessionId,
    toolCallId: toolUseId,
    requestedSchema: {
      type: "object",
      properties,
      required,
    },
  } as CreateElicitationRequest;
}

const KNOWN_ACTIONS = new Set(["accept", "decline", "cancel"]);

function hasKnownAction(resp: unknown): resp is CreateElicitationResponse & { action: string } {
  return (
    typeof resp === "object" &&
    resp !== null &&
    "action" in resp &&
    typeof (resp as { action: unknown }).action === "string" &&
    KNOWN_ACTIONS.has((resp as { action: string }).action)
  );
}

export function mapOutcomeToDecision(resp: CreateElicitationResponse): ElicitationDecision {
  const view = resp as {
    action?: unknown;
    content?: Record<string, unknown> | null;
  } | null;

  if (view?.action === "accept") {
    const content = view.content;
    const answers =
      content !== undefined && content !== null
        ? Object.entries(content)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", ")
        : "";
    const reason =
      answers.length > 0
        ? `AskUserQuestion answered by the user: ${answers}. (The tool is always denied at the ` +
          `gate; this selection is returned to you via this reason.)`
        : `AskUserQuestion was accepted but returned no selection. (The tool is always denied at ` +
          `the gate; treat this as no usable answer.)`;
    return { decision: "deny", reason };
  }

  return {
    decision: "deny",
    reason:
      `The user dismissed the AskUserQuestion prompt without providing an answer (no answer was ` +
      `selected). (The tool is always denied at the gate.)`,
  };
}

export interface RequestElicitationOptions {
  timeoutMs: number;
  onWarn?: (message: string) => void;
}

function failClosedCancel(): CreateElicitationResponse {
  return { action: "cancel" } as CreateElicitationResponse;
}

export async function requestElicitation(
  client: ElicitationClient,
  req: CreateElicitationRequest,
  opts: RequestElicitationOptions,
): Promise<CreateElicitationResponse> {
  const { timeoutMs, onWarn } = opts;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ __timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });

  try {
    const settled = await Promise.race([
      Promise.resolve()
        .then(() => client.createElicitation(req))
        .then(
          (resp): { ok: true; resp: unknown } => ({ ok: true, resp }),
          (err): { ok: false; err: unknown } => ({ ok: false, err }),
        ),
      timeout,
    ]);

    if ("__timedOut" in settled) {
      onWarn?.(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion elicitation timed out after ${timeoutMs}ms ` +
          `— resolving as a cancel (dismissal), never an accept.`,
      );
      return failClosedCancel();
    }

    if (!settled.ok) {
      const err = settled.err;
      onWarn?.(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion elicitation transport error ` +
          `(${err instanceof Error ? err.message : String(err)}) — resolving as a cancel.`,
      );
      return failClosedCancel();
    }

    if (hasKnownAction(settled.resp)) {
      return settled.resp;
    }
    onWarn?.(
      `[gate elicitation] FAIL CLOSED: malformed elicitation response (action not accept|decline|` +
        `cancel) — resolving as a cancel.`,
    );
    return failClosedCancel();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
