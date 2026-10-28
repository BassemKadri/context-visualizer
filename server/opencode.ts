import { countTokens, countJSONTokens } from "./tokenizer.ts";
import { SNAPSHOT_SCHEMA_VERSION, type Bucket, type LeafItem, type ProjectInfo, type SessionListItem, type Snapshot } from "./types.ts";

// The CLI discovers/authenticates with the local V2 service. Never contact a
// hard-coded port or read OpenCode's private database directly.
async function request<T>(path: string): Promise<T> {
  const proc = Bun.spawn(["opencode", "api", "get", path], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`OpenCode API: ${err.trim() || out.trim() || `exit ${code}`}`);
  return JSON.parse(out) as T;
}

type Project = { id: string; canonical: string; name?: string };
type Session = {
  id: string;
  projectID: string;
  title?: string;
  model?: { id: string };
  location: { directory: string };
  time: { created: number; updated: number };
};
type Usage = { input: number; output: number; cache: { read: number; write: number } };
type Message = {
  type: string;
  text?: string;
  summary?: string;
  status?: string;
  reason?: string;
  model?: { id: string };
  tokens?: Usage;
  content?: Array<{ type: string; text?: string; name?: string; state?: {
    status: string; input?: unknown; content?: Array<{ type: string; text?: string; file?: unknown }>;
    error?: unknown;
  } }>;
  files?: Array<{ name?: string; mime?: string }>;
};
type Page<T> = { data: T[]; cursor: { next: string | null } };

const projectSlug = (id: string) => `opencode:${id}`;
const projectId = (slug: string) => slug.slice("opencode:".length);
const total = (u: Usage) => (u.input ?? 0) + (u.cache?.read ?? 0) + (u.cache?.write ?? 0);

async function pages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const url = `${path}${path.includes("?") ? "&" : "?"}${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=asc"}&limit=100`;
    const page: Page<T> = await request(url);
    items.push(...page.data);
    cursor = page.cursor?.next ?? null;
    if (cursor && seen.has(cursor)) throw new Error("OpenCode pagination loop");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

export async function listOpenCodeProjects(): Promise<ProjectInfo[]> {
  const projects = await request<Project[]>("/api/project");
  const sessions = await pages<Session>("/api/session");
  return projects.map((p) => {
    const own = sessions.filter((s) => s.projectID === p.id);
    return {
      source: "opencode" as const,
      slug: projectSlug(p.id),
      path: p.canonical,
      sessionCount: own.length,
      latestMtimeMs: Math.max(0, ...own.map((s) => s.time.updated)),
    };
  }).filter((p) => p.sessionCount > 0);
}

export async function listOpenCodeSessions(slug: string): Promise<SessionListItem[]> {
  const sessions = await pages<Session>(`/api/session?project=${encodeURIComponent(projectId(slug))}`);
  return sessions.map((s): SessionListItem => ({
    source: "opencode",
    id: s.id,
    project: slug,
    projectPath: s.location.directory,
    filePath: `opencode://${s.id}`,
    mtimeMs: s.time.updated,
    title: s.title || "(untitled)",
    // Session tokens are cumulative, NOT the last model call's context usage.
    realTotal: null,
    model: s.model?.id ?? null,
    hasCompaction: false,
  })).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function add(buckets: Map<string, Map<string, { name: string; items: LeafItem[] }>>,
  bucket: string, child: string, name: string, item: LeafItem) {
  let children = buckets.get(bucket);
  if (!children) buckets.set(bucket, children = new Map());
  let group = children.get(child);
  if (!group) children.set(child, group = { name, items: [] });
  group.items.push(item);
}

function summarize(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? line.slice(0, 120) + "…" : line;
}

function contentText(contents: Array<{ type: string; text?: string; file?: unknown }> | undefined): string {
  return (contents ?? []).map((c) => c.type === "text" ? c.text ?? "" : `[${c.type}]`).join("\n");
}

export async function computeOpenCodeSnapshot(id: string): Promise<Snapshot> {
  const [session, messages] = await Promise.all([
    request<{ data: Session }>(`/api/session/${encodeURIComponent(id)}`),
    pages<Message>(`/api/session/${encodeURIComponent(id)}/message`),
  ]);
  const warnings: string[] = ["OpenCode category counts are estimates (cl100k_base); model tokenization and hidden context may differ."];
  const anchor = messages.findLastIndex((m) => m.type === "assistant" && m.tokens && total(m.tokens) > 0);
  const model = anchor >= 0 ? messages[anchor]?.model?.id ?? "unknown" : "unknown";
  const usage = anchor >= 0 ? messages[anchor]!.tokens! : null;
  const realTotal = usage ? total(usage) : 0;
  if (!usage) warnings.push("No assistant message with input usage found.");

  const boundaries = messages.map((m, i) => m.type === "compaction" && m.status === "completed" ? i : -1).filter((i) => i >= 0);
  const boundary = boundaries.filter((i) => i < anchor).at(-1) ?? -1;
  const compaction = boundary < 0 ? null : {
    boundaryCount: boundaries.length,
    latestBoundaryAt: boundary,
    preTokens: 0,
    postTokens: 0,
    trigger: messages[boundary]?.reason ?? "unknown",
  };

  const groups = new Map<string, Map<string, { name: string; items: LeafItem[] }>>();
  let turn = 0;
  // Include the completed compaction summary, not the old messages it replaced.
  for (const m of messages.slice(Math.max(0, boundary), Math.max(0, anchor))) {
    if (m.type === "user" || m.type === "assistant") turn++;
    const leaf = (text: string, summary = summarize(text), toolInput?: string): LeafItem => ({
      tokens: countTokens(text), turn, summary, fullContent: text.slice(0, 50_000), toolInput,
    });
    if (m.type === "user" && m.text) add(groups, "messages", "user", "User messages", leaf(m.text));
    if (m.type === "user") for (const file of m.files ?? []) {
      const name = file.name ?? file.mime ?? "file";
      add(groups, "attachments", "files", "Files", {
        tokens: 0, turn, summary: name, fullContent: "File or image payloads cannot be estimated from the session message.",
      });
    }
    if (m.type === "compaction" && m.status === "completed" && m.summary)
      add(groups, "messages", "summary", "Compaction summary", leaf(m.summary));
    if (m.type === "synthetic" && m.text) add(groups, "messages", "synthetic", "Synthetic messages", leaf(m.text));
    if (m.type === "system" && m.text) add(groups, "messages", "system_text", "System messages", leaf(m.text));
    if (m.type === "skill" && m.text) add(groups, "messages", "skills", "Skills", leaf(m.text));
    if (m.type === "assistant") for (const part of m.content ?? []) {
      if (part.type === "text" && part.text)
        add(groups, "messages", "assistant", "Assistant text", leaf(part.text));
      if (part.type === "reasoning" && part.text)
        add(groups, "messages", "thinking", "Thinking", leaf(part.text));
      if (part.type !== "tool") continue;
      const name = part.name ?? "unknown";
      const input = part.state?.input ?? {};
      const inputText = JSON.stringify(input, null, 2);
      add(groups, "tool_calls", name, name, {
        tokens: countJSONTokens(input) + countTokens(name), turn,
        summary: `${name} ${summarize(inputText)}`, fullContent: "", toolInput: inputText.slice(0, 50_000),
      });
      if (part.state?.status === "completed" || part.state?.status === "error") {
        const text = contentText(part.state.content) || (part.state.error ? JSON.stringify(part.state.error) : "");
        if (text) add(groups, "tool_results", name, name, leaf(text, `${name} result`, inputText.slice(0, 50_000)));
      }
    }
  }

  const buckets: Bucket[] = [...groups].map(([id, children]) => ({
    id,
    name: { messages: "Messages", tool_calls: "Tool calls", tool_results: "Tool results", attachments: "Attachments" }[id] ?? id,
    children: [...children].map(([key, group]) => ({
      id: key, name: group.name, tokens: group.items.reduce((sum, it) => sum + it.tokens, 0), items: group.items,
    })),
    tokens: 0,
  }));
  for (const b of buckets) b.tokens = b.children.reduce((sum, c) => sum + c.tokens, 0);
  const identified = buckets.reduce((sum, b) => sum + b.tokens, 0);
  if (identified > realTotal && identified > 0) {
    const factor = realTotal / identified;
    warnings.push("Visible content exceeds input usage; estimated categories were scaled to fit.");
    for (const b of buckets) {
      for (const c of b.children) {
        for (const item of c.items) item.tokens = Math.round(item.tokens * factor);
        c.tokens = c.items.reduce((sum, it) => sum + it.tokens, 0);
      }
      b.tokens = b.children.reduce((sum, c) => sum + c.tokens, 0);
    }
  }
  const residual = Math.max(0, realTotal - buckets.reduce((sum, b) => sum + b.tokens, 0));
  buckets.unshift({ id: "system", name: "System prompt + tool schemas", tokens: residual, children: [{
    id: "system_residual", name: "Unidentified context (estimated)", tokens: residual,
    items: [{ tokens: residual, turn: 0, summary: "Hidden prompts, tool schemas, wrappers and uncounted content",
      fullContent: "Residual = last assistant input usage − estimated visible categories. This is not a direct measurement of the system prompt." }],
  }] });

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION, sessionId: id, filePath: `opencode://${id}`,
    mtimeMs: session.data.time.updated,
    headline: { realTotal, modelCap: 0, model, inputTokens: usage?.input ?? 0,
      cacheCreationTokens: usage?.cache?.write ?? 0, cacheReadTokens: usage?.cache?.read ?? 0,
      outputTokens: usage?.output ?? 0 },
    buckets, compaction, warnings,
  };
}
