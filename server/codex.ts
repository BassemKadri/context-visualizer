import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { CODEX_SESSIONS_DIR } from "./paths.ts";
import { readAllJSONL, streamJSONL } from "./jsonl.ts";
import { countJSONTokens, countTokens } from "./tokenizer.ts";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type Bucket,
  type LeafItem,
  type ProjectInfo,
  type SessionListItem,
  type Snapshot,
} from "./types.ts";

const SOURCE_PREFIX = "codex_";
const PROJECT_PREFIX = "codex:";
const IO_CONCURRENCY = 16;

type CodexMeta = {
  id: string;
  cwd: string;
  timestamp?: string;
};

type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

type IndexedFile = {
  filePath: string;
  mtimeMs: number;
  meta: CodexMeta;
};

const externalId = (id: string) => `${SOURCE_PREFIX}${id}`;
const rawId = (id: string) => id.startsWith(SOURCE_PREFIX) ? id.slice(SOURCE_PREFIX.length) : id;
const projectSlug = (cwd: string) => `${PROJECT_PREFIX}${Buffer.from(cwd, "utf8").toString("base64url")}`;
const projectPath = (slug: string) => Buffer.from(slug.slice(PROJECT_PREFIX.length), "base64url").toString("utf8");

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function findJSONLFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findJSONLFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }));
  return found;
}

async function readMetaQuick(filePath: string): Promise<CodexMeta | null> {
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.type !== "session_meta") continue;
        const payload = record.payload ?? {};
        const id = payload.id ?? payload.session_id;
        if (typeof id === "string" && typeof payload.cwd === "string") {
          return { id, cwd: payload.cwd, timestamp: payload.timestamp };
        }
      } catch {}
    }
    return null;
  } finally {
    await file.close();
  }
}

async function indexedFiles(): Promise<IndexedFile[]> {
  const files = await findJSONLFiles(CODEX_SESSIONS_DIR);
  const indexed = await mapLimit(files, IO_CONCURRENCY, async (filePath): Promise<IndexedFile | null> => {
    try {
      const [meta, info] = await Promise.all([readMetaQuick(filePath), stat(filePath)]);
      return meta ? { filePath, mtimeMs: info.mtimeMs, meta } : null;
    } catch {
      return null;
    }
  });
  return indexed.filter((item): item is IndexedFile => item !== null);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const value = part as any;
    return typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n");
}

function cleanTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 100 ? `${cleaned.slice(0, 100)}…` : cleaned;
}

function isInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<environment_context>") || trimmed.startsWith("<permissions instructions>");
}

function latestUsage(records: any[]): { index: number; usage: CodexUsage } | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record?.type === "token_usage_record" && (record.payload?.usage?.input_tokens ?? 0) > 0) {
      return { index: i, usage: record.payload.usage };
    }
    const last = record?.type === "event_msg" && record.payload?.type === "token_count"
      ? record.payload?.info?.last_token_usage
      : null;
    if ((last?.input_tokens ?? 0) > 0) return { index: i, usage: last };
  }
  return null;
}

async function indexSession(file: IndexedFile): Promise<SessionListItem> {
  let title = "";
  let model: string | null = null;
  let realTotal: number | null = null;
  let hasCompaction = false;

  await streamJSONL(file.filePath, (record) => {
    if (record?.type === "compacted") hasCompaction = true;
    if (record?.type === "turn_context" && typeof record.payload?.model === "string") model = record.payload.model;
    if (record?.type === "token_usage_record" && (record.payload?.usage?.input_tokens ?? 0) > 0) {
      realTotal = record.payload.usage.input_tokens;
    }
    if (!title && record?.type === "response_item" && record.payload?.type === "message" && record.payload?.role === "user") {
      const text = textFromContent(record.payload.content);
      if (text && !isInjectedUserText(text)) title = cleanTitle(text);
    }
  });

  return {
    source: "codex",
    id: externalId(file.meta.id),
    project: projectSlug(file.meta.cwd),
    projectPath: file.meta.cwd,
    filePath: `codex://${file.meta.id}`,
    mtimeMs: file.mtimeMs,
    title: title || "(no user message)",
    realTotal,
    model,
    hasCompaction,
  };
}

export async function listCodexProjects(): Promise<ProjectInfo[]> {
  const files = await indexedFiles();
  const groups = new Map<string, IndexedFile[]>();
  for (const file of files) {
    const own = groups.get(file.meta.cwd) ?? [];
    own.push(file);
    groups.set(file.meta.cwd, own);
  }
  return [...groups].map(([cwd, own]) => ({
    source: "codex" as const,
    slug: projectSlug(cwd),
    path: cwd,
    sessionCount: own.length,
    latestMtimeMs: Math.max(...own.map((file) => file.mtimeMs)),
  })).sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
}

export async function listCodexSessions(slug: string): Promise<SessionListItem[]> {
  const cwd = projectPath(slug);
  const files = (await indexedFiles()).filter((file) => file.meta.cwd === cwd);
  const sessions = await mapLimit(files, IO_CONCURRENCY, indexSession);
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function findCodexSessionById(id: string): Promise<string | null> {
  const wanted = rawId(id);
  const files = await findJSONLFiles(CODEX_SESSIONS_DIR);
  const filenameMatch = files.find((file) => basename(file, ".jsonl").endsWith(wanted));
  if (filenameMatch) return filenameMatch;
  for (const file of files) {
    if ((await readMetaQuick(file))?.id === wanted) return file;
  }
  return null;
}

type Group = { name: string; items: LeafItem[] };

function add(groups: Map<string, Map<string, Group>>, bucket: string, child: string, name: string, item: LeafItem) {
  let children = groups.get(bucket);
  if (!children) groups.set(bucket, children = new Map());
  let group = children.get(child);
  if (!group) children.set(child, group = { name, items: [] });
  group.items.push(item);
}

function summarize(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function inputBoundary(record: any): boolean {
  if (record?.type !== "response_item") return false;
  const payload = record.payload ?? {};
  if (payload.type === "message" && payload.role !== "assistant") return true;
  return typeof payload.type === "string" && payload.type.endsWith("_output");
}

function toolName(payload: any): string {
  return payload.name ?? payload.server_label ?? payload.type?.replace(/_call(?:_output)?$/, "") ?? "tool";
}

function toolInput(payload: any): unknown {
  if (payload.input !== undefined) return payload.input;
  if (payload.arguments !== undefined) {
    if (typeof payload.arguments === "string") {
      try { return JSON.parse(payload.arguments); } catch { return payload.arguments; }
    }
    return payload.arguments;
  }
  return payload.action ?? {};
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  return JSON.stringify(output, null, 2);
}

export async function computeCodexSnapshot(filePath: string, mtimeMs: number, id: string): Promise<Snapshot> {
  const records = await readAllJSONL(filePath);
  const anchor = latestUsage(records);
  const warnings = ["Codex category counts are estimates (cl100k_base); hidden instructions and encrypted reasoning are included in the residual."];
  if (!anchor) warnings.push("No Codex model call with input usage found.");

  const anchorIndex = anchor?.index ?? records.length;
  const compacted = records.map((record, index) => record?.type === "compacted" && index < anchorIndex ? index : -1).filter((index) => index >= 0);
  const boundary = compacted.at(-1) ?? -1;
  let contentEnd = anchorIndex;
  for (let i = anchorIndex - 1; i > boundary; i--) {
    if (inputBoundary(records[i])) {
      contentEnd = i + 1;
      break;
    }
  }

  let model = "unknown";
  let modelCap = 0;
  for (let i = 0; i <= anchorIndex; i++) {
    const record = records[i];
    if (record?.type === "turn_context") {
      if (typeof record.payload?.model === "string") model = record.payload.model;
      if (typeof record.payload?.model_context_window === "number") modelCap = record.payload.model_context_window;
    }
    if (record?.type === "event_msg" && record.payload?.type === "token_count") {
      modelCap = record.payload?.info?.model_context_window ?? modelCap;
    }
  }

  const groups = new Map<string, Map<string, Group>>();
  const callNames = new Map<string, string>();
  let turn = 0;
  for (let i = boundary + 1; i < contentEnd; i++) {
    const record = records[i];
    if (record?.type === "turn_context") {
      turn++;
      continue;
    }
    if (record?.type !== "response_item") continue;
    const payload = record.payload ?? {};
    const leaf = (text: string, summary = summarize(text), input?: string): LeafItem => ({
      tokens: countTokens(text),
      turn,
      summary,
      fullContent: text.slice(0, 50_000),
      toolInput: input,
    });

    if (payload.type === "message") {
      const text = textFromContent(payload.content);
      if (!text) continue;
      if (payload.role === "assistant") add(groups, "messages", "assistant", "Assistant text", leaf(text));
      else if (payload.role === "developer") add(groups, "messages", "developer", "Developer instructions", leaf(text));
      else if (payload.role === "system") add(groups, "messages", "system_text", "System messages", leaf(text));
      else if (isInjectedUserText(text)) add(groups, "messages", "environment", "Environment context", leaf(text));
      else add(groups, "messages", "user", "User messages", leaf(text));
      for (const part of Array.isArray(payload.content) ? payload.content : []) {
        if (part?.type === "input_image" || part?.type === "image_url") {
          add(groups, "attachments", "images", "Images", {
            tokens: 0, turn, summary: "Image attachment", fullContent: "Image token usage is included in the unidentified residual.",
          });
        }
      }
      continue;
    }

    if (payload.type === "reasoning") {
      const text = textFromContent(payload.summary);
      if (text) add(groups, "messages", "thinking", "Reasoning summaries", leaf(text));
      continue;
    }

    if (typeof payload.type === "string" && payload.type.endsWith("_call_output")) {
      const name = callNames.get(payload.call_id) ?? toolName(payload);
      const text = outputText(payload.output ?? payload.result ?? payload.error);
      if (text) add(groups, "tool_results", name, name, leaf(text, `${name} result`));
      continue;
    }

    if (typeof payload.type === "string" && (payload.type.endsWith("_call") || payload.type === "mcp_tool_call")) {
      const name = toolName(payload);
      if (payload.call_id) callNames.set(payload.call_id, name);
      const input = toolInput(payload);
      const inputText = typeof input === "string" ? input : JSON.stringify(input, null, 2);
      add(groups, "tool_calls", name, name, {
        tokens: countTokens(name) + countJSONTokens(input),
        turn,
        summary: `${name} ${summarize(inputText)}`,
        fullContent: "",
        toolInput: inputText.slice(0, 50_000),
      });
      const result = outputText(payload.output ?? payload.result ?? payload.error);
      if (result) add(groups, "tool_results", name, name, leaf(result, `${name} result`, inputText.slice(0, 50_000)));
    }
  }

  const buckets: Bucket[] = [...groups].map(([id, children]) => ({
    id,
    name: { messages: "Messages", tool_calls: "Tool calls", tool_results: "Tool results", attachments: "Attachments" }[id] ?? id,
    children: [...children].map(([childId, group]) => ({
      id: childId,
      name: group.name,
      tokens: group.items.reduce((sum, item) => sum + item.tokens, 0),
      items: group.items,
    })),
    tokens: 0,
  }));
  for (const bucket of buckets) bucket.tokens = bucket.children.reduce((sum, child) => sum + child.tokens, 0);

  const usage = anchor?.usage;
  const realTotal = usage?.input_tokens ?? 0;
  const identified = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  if (identified > realTotal && identified > 0) {
    const factor = realTotal / identified;
    warnings.push("Visible content exceeds Codex input usage; estimated categories were scaled to fit.");
    for (const bucket of buckets) {
      for (const child of bucket.children) {
        for (const item of child.items) item.tokens = Math.round(item.tokens * factor);
        child.tokens = child.items.reduce((sum, item) => sum + item.tokens, 0);
      }
      bucket.tokens = bucket.children.reduce((sum, child) => sum + child.tokens, 0);
    }
  }
  const residual = Math.max(0, realTotal - buckets.reduce((sum, bucket) => sum + bucket.tokens, 0));
  buckets.unshift({
    id: "system",
    name: "System prompt + tool schemas",
    tokens: residual,
    children: [{
      id: "system_residual",
      name: "Unidentified context (estimated)",
      tokens: residual,
      items: [{
        tokens: residual,
        turn: 0,
        summary: "Hidden prompts, tool schemas, encrypted reasoning and uncounted content",
        fullContent: "Residual = Codex input_tokens − estimated visible categories. Cached input is already included in input_tokens.",
      }],
    }],
  });

  const cached = usage?.cached_input_tokens ?? 0;
  const cacheWrite = usage?.cache_write_input_tokens ?? 0;
  const compactionRecord = boundary >= 0 ? records[boundary] : null;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sessionId: id,
    filePath: `codex://${rawId(id)}`,
    mtimeMs,
    headline: {
      realTotal,
      modelCap,
      model,
      inputTokens: Math.max(0, realTotal - cached - cacheWrite),
      cacheCreationTokens: cacheWrite,
      cacheReadTokens: cached,
      outputTokens: usage?.output_tokens ?? 0,
    },
    buckets,
    compaction: boundary < 0 ? null : {
      boundaryCount: compacted.length,
      latestBoundaryAt: boundary,
      preTokens: compactionRecord?.payload?.latest_token_usage_record?.usage?.input_tokens ?? 0,
      postTokens: 0,
      trigger: "automatic",
    },
    warnings,
  };
}
