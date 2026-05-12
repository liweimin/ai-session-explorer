import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const cacheRoot = path.join(repoRoot, ".cache", "session-explorer");
const detailsRoot = path.join(cacheRoot, "details");
const replayEditorRoot = path.join(cacheRoot, "replay-editor");
const legacySummariesRoot = path.join(cacheRoot, "summaries");
const indexPath = path.join(cacheRoot, "index.json");
const manifestPath = path.join(cacheRoot, "manifest.json");
const envLocalPath = path.join(repoRoot, ".env.local");
const htmlPath = path.join(repoRoot, "Session-Explorer.html");
const cacheVersion = 12;

function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || "");
  }
  return env;
}

function readLocalEnvSync() {
  try {
    return parseEnvText(readFileSync(envLocalPath, "utf8"));
  } catch {
    return {};
  }
}

const localEnv = readLocalEnvSync();
function readConfigValue(key, fallback = "") {
  return localEnv[key] || process.env[key] || fallback;
}

function resolveConfiguredPath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Missing SESSION_DATA_ROOT. This repository uses split mode only. Set SESSION_DATA_ROOT in .env.local to your private data repository data directory.");
  }
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(repoRoot, raw));
}

const dataRoot = resolveConfiguredPath(readConfigValue("SESSION_DATA_ROOT"));
const repoDataRoot = path.resolve(repoRoot, "data");
const dataRootLower = dataRoot.toLowerCase();
const repoRootLower = repoRoot.toLowerCase();
const repoDataRootLower = repoDataRoot.toLowerCase();
if (dataRootLower === repoDataRootLower || dataRootLower.startsWith(`${repoRootLower}${path.sep}`)) {
  throw new Error("SESSION_DATA_ROOT must be outside the public tool repository. Point it to the data directory inside your private data repository.");
}
const summariesRoot = path.join(dataRoot, "session_summaries");
const port = Number(readConfigValue("SESSION_EXPLORER_PORT", "8788"));

let refreshState = {
  running: false,
  phase: "idle",
  last_error: "",
  started_at: "",
  finished_at: ""
};
let buildPromise = null;
const githubRemoteCache = new Map();
const replayEditorProcesses = new Map();

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function safeFileName(value) {
  return String(value || "unknown").replace(/[<>:"/\\|?*%\u0000-\u001F]/g, "_");
}

function normalizeText(value, maxLength = 0) {
  if (value === null || value === undefined) return "";
  let text = String(value)
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\[[0-9;]+m/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
  }
  return text;
}

function normalizeBlockText(value, maxLength = 0) {
  if (value === null || value === undefined) return "";
  let text = String(value)
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\[[0-9;]+m/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/(\r?\n){3,}/g, "\n\n")
    .trim();

  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
  }
  return text;
}

function normalizeGitHubRemote(value) {
  const text = normalizeText(value);
  if (!text || !/github\.com/i.test(text)) return "未确认";

  const sshMatch = text.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;

  const httpsMatch = text.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;

  return text;
}

function readGitHubRemote(cwd = repoRoot) {
  const cacheKey = String(cwd || repoRoot);
  if (githubRemoteCache.has(cacheKey)) return githubRemoteCache.get(cacheKey);
  const pending = new Promise((resolve) => {
    const child = spawn("git", ["remote", "get-url", "origin"], {
      cwd,
      windowsHide: true
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("未确认");
    }, 2500);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("未确认");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? normalizeGitHubRemote(stdout) : "未确认");
    });
  });
  githubRemoteCache.set(cacheKey, pending);
  return pending;
}

async function pathType(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    if (stats.isDirectory()) return "dir";
    if (stats.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

function describeProjectPath(relPath, kind) {
  const normalized = toPosix(relPath).replace(/^\.\/+/, "");
  const base = normalized.split("/").pop() || normalized;
  const lower = normalized.toLowerCase();

  if (lower === "package.json") return "Node 项目清单与脚本入口";
  if (lower === "pnpm-workspace.yaml") return "pnpm workspace 配置";
  if (lower === "tsconfig.json") return "TypeScript 编译配置";
  if (lower === "vite.config.ts" || lower === "vite.config.js" || lower === "vite.config.mjs") return "Vite 构建配置";
  if (lower === "next.config.js" || lower === "next.config.mjs" || lower === "next.config.ts") return "Next.js 配置";
  if (lower === "nuxt.config.ts" || lower === "nuxt.config.js") return "Nuxt 配置";
  if (lower === "pyproject.toml") return "Python 项目清单";
  if (lower === "requirements.txt") return "Python 依赖清单";
  if (lower === "cargo.toml") return "Rust 项目清单";
  if (lower === "go.mod") return "Go 模块清单";
  if (lower === "readme.md" || lower === "readme") return "项目说明文档";
  if (lower === "dockerfile" || lower === "docker-compose.yml" || lower === "docker-compose.yaml") return "容器相关配置";
  if (lower === "index.html") return "前端 HTML 入口";
  if (lower.startsWith("src/")) return "主源码目录或核心源码文件";
  if (lower.startsWith("app/")) return "应用主目录";
  if (lower.startsWith("pages/")) return "页面或路由目录";
  if (lower.startsWith("components/")) return "组件目录";
  if (lower.startsWith("scripts/")) return "项目脚本目录";
  if (lower.startsWith("docs/")) return "文档目录";
  if (lower.startsWith("public/")) return "静态资源目录";
  if (lower.startsWith("lib/")) return "共享库目录";
  if (lower.startsWith("server/")) return "服务端代码目录";
  if (lower.startsWith("api/")) return "接口目录";
  if (kind === "dir") return `${base} 目录`;
  return `${base} 文件`;
}

async function collectProjectPaths(cwd) {
  if (!cwd || cwd === "-") {
    return {
      cwd_status: "未提供工作目录",
      github_remote: "未确认",
      top_level_entries: [],
      key_paths: []
    };
  }

  const cwdType = await pathType(cwd);
  if (cwdType !== "dir") {
    return {
      cwd_status: cwdType === "missing" ? "工作目录在本机不可访问" : "工作目录不是目录",
      github_remote: "未确认",
      top_level_entries: [],
      key_paths: []
    };
  }

  const githubRemote = await readGitHubRemote(cwd);
  const topEntries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
  const topLevelEntries = topEntries
    .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`)
    .slice(0, 20);

  const candidatePaths = [
    "README.md",
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "index.html",
    "src",
    "app",
    "pages",
    "components",
    "lib",
    "public",
    "scripts",
    "docs",
    "server",
    "api"
  ];

  const keyPaths = [];
  for (const candidate of candidatePaths) {
    const fullPath = path.join(cwd, candidate);
    const candidateType = await pathType(fullPath);
    if (candidateType === "missing" || candidateType === "other") continue;
    keyPaths.push({
      path: toPosix(candidate),
      role: describeProjectPath(candidate, candidateType)
    });
  }

  return {
    cwd_status: topEntries.length ? "工作目录可访问" : "工作目录可访问，但当前目录为空或未识别到工程文件",
    github_remote: githubRemote,
    top_level_entries: topLevelEntries,
    key_paths: keyPaths
  };
}

function isNoiseUserMessage(value) {
  const text = normalizeText(value);
  return !text ||
    /^<environment_context>/.test(text) ||
    /^# AGENTS\.md instructions\b/.test(text) ||
    /^<turn_aborted>/.test(text);
}

function isBadTitle(value) {
  const text = normalizeText(value);
  return !text || /<environment_context>|<\/|<fault|\{|\}|_text|^"/.test(text);
}

function projectName(cwd) {
  if (!cwd) return "";
  try {
    return path.basename(String(cwd).replace(/[\\/]+$/, ""));
  } catch {
    return String(cwd);
  }
}

function isoDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function localTimeLabel(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date).replace(/\//g, "/");
}

function msFromTimestamp(value) {
  if (!value) return 0;
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function textFromCodexContent(content) {
  if (typeof content === "string") return normalizeBlockText(content);
  const parts = [];
  for (const item of Array.isArray(content) ? content : [content]) {
    if (!item) continue;
    if ((item.type === "input_text" || item.type === "output_text" || item.type === "text") && item.text) {
      parts.push(String(item.text));
    }
  }
  return normalizeBlockText(parts.join("\n\n"));
}

function textFromClaudeContent(content) {
  if (typeof content === "string") return normalizeBlockText(content);
  const parts = [];
  for (const item of Array.isArray(content) ? content : [content]) {
    if (!item) continue;
    if (item.type === "text" && item.text) parts.push(String(item.text));
  }
  return normalizeBlockText(parts.join("\n\n"));
}

function isClaudeToolResult(content) {
  return Array.isArray(content) && content.some((item) => item && item.type === "tool_result");
}

function claudeToolResultText(content) {
  const parts = [];
  for (const item of Array.isArray(content) ? content : [content]) {
    if (!item || item.type !== "tool_result") continue;
    if (typeof item.content === "string") {
      parts.push(item.content);
    } else if (Array.isArray(item.content)) {
      for (const nested of item.content) {
        if (nested && nested.text) parts.push(String(nested.text));
      }
    }
  }
  return normalizeBlockText(parts.join("\n\n"), 1600);
}

function claudeToolUseText(item) {
  const input = item && item.input ? JSON.stringify(item.input) : "";
  return normalizeBlockText(input, 1200);
}

function stringifyStructured(value, maxLength = 0) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return normalizeBlockText(value, maxLength);
  try {
    return normalizeBlockText(JSON.stringify(value, null, 2), maxLength);
  } catch {
    return normalizeBlockText(String(value), maxLength);
  }
}

function codexToolCallText(payload) {
  if (!payload) return "";
  if (payload.arguments) return stringifyStructured(payload.arguments, 3200);
  if (payload.input !== undefined) return stringifyStructured(payload.input, 3200);
  const subset = {};
  for (const key of ["query", "prompt", "url", "urls", "domains", "ref_id", "ticker", "location"]) {
    if (payload[key] !== undefined) subset[key] = payload[key];
  }
  return stringifyStructured(Object.keys(subset).length ? subset : payload, 3200);
}

function codexToolOutputText(payload) {
  if (!payload) return "";
  if (payload.output !== undefined) return stringifyStructured(payload.output, 3200);
  if (payload.result !== undefined) return stringifyStructured(payload.result, 3200);
  if (payload.results !== undefined) return stringifyStructured(payload.results, 3200);
  return stringifyStructured(payload, 3200);
}

function codexToolLabel(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
    if (typeof value.type === "string" && value.type.trim()) return value.type.trim();
  }
  return fallback;
}

function codexTurnContextText(payload) {
  if (!payload) return "";
  const lines = ["## 运行上下文"];
  if (payload.cwd) lines.push(`- cwd: ${payload.cwd}`);
  if (payload.current_date) lines.push(`- current_date: ${payload.current_date}`);
  if (payload.timezone) lines.push(`- timezone: ${payload.timezone}`);
  if (payload.model) lines.push(`- model: ${payload.model}`);
  if (payload.approval_policy) lines.push(`- approval_policy: ${payload.approval_policy}`);
  if (payload.personality) lines.push(`- personality: ${payload.personality}`);
  if (payload.realtime_active !== undefined) lines.push(`- realtime_active: ${String(payload.realtime_active)}`);
  if (payload.effort) lines.push(`- effort: ${payload.effort}`);
  if (payload.summary) lines.push(`- summary: ${payload.summary}`);
  if (payload.sandbox_policy) lines.push(`- sandbox_policy: ${stringifyStructured(payload.sandbox_policy)}`);
  if (payload.permission_profile) lines.push(`- permission_profile: ${stringifyStructured(payload.permission_profile)}`);
  if (payload.collaboration_mode) lines.push(`- collaboration_mode: ${stringifyStructured(payload.collaboration_mode)}`);
  if (payload.developer_instructions) {
    lines.push("");
    lines.push("## 开发者附加指令");
    lines.push(String(payload.developer_instructions));
  }
  return normalizeBlockText(lines.join("\n"), 0);
}

function codexCompactedText(payload) {
  if (!payload) return "";
  const lines = [];
  if (payload.message) lines.push(String(payload.message));
  if (Array.isArray(payload.replacement_history) && payload.replacement_history.length) {
    lines.push("");
    lines.push(`replacement_history: ${payload.replacement_history.length} 条`);
  }
  return normalizeBlockText(lines.join("\n"), 0);
}

function addTranscriptItem(list, seen, kind, label, text, timestamp, maxLength, extra = {}) {
  const userLimit = maxLength === undefined ? 3200 : maxLength;
  const blockLimit = maxLength === undefined ? (kind === "tool" ? 1600 : 3200) : maxLength;
  const normalized = kind === "user"
    ? normalizeText(text, userLimit)
    : normalizeBlockText(text, blockLimit);
  if (!normalized) return;
  if (kind === "user" && isNoiseUserMessage(normalized)) return;

  const timestampText = isoDate(timestamp);
  const previous = list[list.length - 1];
  if (previous && previous.kind === kind && previous.text === normalized) return;

  const key = `${kind}|${timestampText}|${normalized}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ kind, label, timestamp: timestampText, text: normalized, ...extra });
}

function addUserTurn(list, seen, text, timestamp) {
  const normalized = normalizeText(text, 280);
  if (!normalized || isNoiseUserMessage(normalized)) return null;
  const timestampText = isoDate(timestamp);
  const key = `${timestampText}|${normalized}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const turn = { index: list.length + 1, timestamp: timestampText, text: normalized };
  list.push(turn);
  return turn;
}

async function readJsonl(filePath, onItem) {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      await onItem(JSON.parse(line));
    } catch {
      // Ignore partial/corrupt JSONL rows. Session logs can be written while refreshing.
    }
  }
}

async function readIndexMap() {
  const indexFile = path.join(dataRoot, "session_index.jsonl");
  const map = new Map();
  try {
    await readJsonl(indexFile, (item) => {
      if (item && item.id) map.set(String(item.id), item);
    });
  } catch {
    return map;
  }
  return map;
}

async function enumerateFiles(root, predicate = () => true) {
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

async function directoryMaxMtimeMs(root, predicate = () => true) {
  let maxMtimeMs = 0;
  for (const file of await enumerateFiles(root, predicate)) {
    try {
      const stat = await fs.stat(file);
      maxMtimeMs = Math.max(maxMtimeMs, stat.mtimeMs);
    } catch {
      // Ignore files that disappear while scanning.
    }
  }
  return maxMtimeMs;
}

async function getSessionFiles() {
  const codexActiveRoot = path.join(dataRoot, "sessions");
  const codexArchivedRoot = path.join(dataRoot, "archived_sessions");
  const claudeRoot = path.join(dataRoot, "claude", "projects");
  const files = [];

  for (const file of await enumerateFiles(codexActiveRoot, (item) => item.toLowerCase().endsWith(".jsonl"))) {
    files.push({ file, source: "sessions", source_kind: "codex" });
  }
  for (const file of await enumerateFiles(codexArchivedRoot, (item) => item.toLowerCase().endsWith(".jsonl"))) {
    files.push({ file, source: "archived_sessions", source_kind: "codex" });
  }
  for (const file of await enumerateFiles(claudeRoot, (item) => item.toLowerCase().endsWith(".jsonl"))) {
    files.push({ file, source: "claude_projects", source_kind: "claude_code" });
  }

  return files;
}

async function parseCodexSession(file, source, indexMap) {
  let sessionId = codexRolloutIdFromFile(file);
  let startedAtMs = 0;
  let updatedAtMs = 0;
  let lastTimestampMs = 0;
  let cwd = "";
  let firstObservedUserMessage = "";
  let firstUserMessage = "";
  let lastUserMessage = "";
  let lastAgentMessage = "";
  let lastLifecycle = "";
  let agentNickname = "";
  let agentRole = "";
  let parentThreadId = "";
  let forkedFromId = "";
  const transcriptItems = [];
  const transcriptSeen = new Set();
  const eventUserTurns = [];
  const fallbackUserTurns = [];
  const rawResponseUserTurns = [];
  const eventTurnSeen = new Set();
  const fallbackTurnSeen = new Set();
  const agentMessages = [];
  const toolCallNames = new Map();
  let lastTurnContextText = "";

  function updateUserMessage(text) {
    const message = normalizeText(text, 500);
    if (!message) return;
    if (!firstObservedUserMessage) firstObservedUserMessage = message;
    if (isNoiseUserMessage(message)) return;
    if (!firstUserMessage) firstUserMessage = message;
    lastUserMessage = message;
  }

  await readJsonl(file, (item) => {
    if (item.timestamp) lastTimestampMs = msFromTimestamp(item.timestamp);

    if (item.type === "session_meta") {
      if (item.payload && item.payload.id && !sessionId) sessionId = String(item.payload.id);
      if (item.payload && item.payload.forked_from_id && !forkedFromId) forkedFromId = String(item.payload.forked_from_id);
      if (item.payload && item.payload.timestamp && !startedAtMs) startedAtMs = msFromTimestamp(item.payload.timestamp);
      if (item.payload && item.payload.cwd && !cwd) cwd = String(item.payload.cwd);
      if (item.payload && item.payload.agent_nickname && !agentNickname) agentNickname = String(item.payload.agent_nickname);
      if (item.payload && item.payload.agent_role && !agentRole) agentRole = String(item.payload.agent_role);
      if (item.payload && item.payload.base_instructions && item.payload.base_instructions.text) {
        addTranscriptItem(
          transcriptItems,
          transcriptSeen,
          "system",
          "基础指令",
          item.payload.base_instructions.text,
          lastTimestampMs || startedAtMs,
          0
        );
      }
      const threadSpawn = item.payload && item.payload.source && item.payload.source.subagent
        ? item.payload.source.subagent.thread_spawn
        : null;
      if (threadSpawn && threadSpawn.parent_thread_id) parentThreadId = String(threadSpawn.parent_thread_id);
      return;
    }

    if (item.type === "turn_context" && item.payload) {
      const contextText = codexTurnContextText(item.payload);
      if (contextText && contextText !== lastTurnContextText) {
        addTranscriptItem(transcriptItems, transcriptSeen, "system", "运行上下文", contextText, lastTimestampMs, 0);
        lastTurnContextText = contextText;
      }
      return;
    }

    if (item.type === "compacted" && item.payload) {
      const compactedText = codexCompactedText(item.payload);
      if (compactedText) {
        addTranscriptItem(transcriptItems, transcriptSeen, "system", "上下文压缩", compactedText, lastTimestampMs, 0);
      }
      return;
    }

    if (item.type === "event_msg" && item.payload) {
      const eventType = String(item.payload.type || "");
      if (eventType === "user_message") {
        const message = normalizeText(item.payload.message, 500);
        updateUserMessage(message);
        addUserTurn(eventUserTurns, eventTurnSeen, message, lastTimestampMs);
        addTranscriptItem(transcriptItems, transcriptSeen, "user", "用户", item.payload.message, lastTimestampMs, 0);
        return;
      }
      if (eventType === "agent_message") {
        const message = normalizeText(item.payload.message, 3200);
        if (message) {
          lastAgentMessage = normalizeText(message, 300);
          if (agentMessages.length < 24) agentMessages.push(message);
          addTranscriptItem(transcriptItems, transcriptSeen, "ai", "AI", item.payload.message, lastTimestampMs, 0);
        }
        return;
      }
      if (eventType === "task_started" || eventType === "task_complete") {
        lastLifecycle = eventType;
        if (eventType === "task_complete" && item.payload.last_agent_message) {
          const message = normalizeText(item.payload.last_agent_message, 900);
          if (message) {
            lastAgentMessage = normalizeText(message, 300);
            if (agentMessages.length < 24) agentMessages.push(message);
          }
        }
      }
      return;
    }

    if (item.type === "response_item" && item.payload) {
      const payload = item.payload;
      if (payload.type === "message") {
        if (payload.role === "user") {
          const message = textFromCodexContent(payload.content);
          updateUserMessage(message);
          const rawTurnText = normalizeText(message, 280);
          const rawTurnIndex = rawResponseUserTurns.length + 1;
          if (rawTurnText) {
            rawResponseUserTurns.push({
              index: rawTurnIndex,
              timestamp: isoDate(lastTimestampMs),
              text: rawTurnText
            });
          }
          addUserTurn(fallbackUserTurns, fallbackTurnSeen, message, lastTimestampMs);
          addTranscriptItem(transcriptItems, transcriptSeen, "user", "用户", message, lastTimestampMs, 0, rawTurnText ? { user_turn_index: rawTurnIndex } : {});
        } else if (payload.role === "assistant") {
          const message = textFromCodexContent(payload.content);
          if (message) {
            lastAgentMessage = normalizeText(message, 300);
            if (agentMessages.length < 24) agentMessages.push(message);
            addTranscriptItem(transcriptItems, transcriptSeen, "ai", "AI", message, lastTimestampMs, 0);
          }
        } else if (payload.role === "developer" || payload.role === "system") {
          const message = textFromCodexContent(payload.content);
          if (message) {
            addTranscriptItem(
              transcriptItems,
              transcriptSeen,
              payload.role === "developer" ? "developer" : "system",
              payload.role === "developer" ? "开发者" : "系统",
              message,
              lastTimestampMs,
              0
            );
          }
        }
      } else if (payload.type === "function_call") {
        const label = codexToolLabel(payload.name, "工具");
        if (payload.call_id && payload.name) toolCallNames.set(String(payload.call_id), label);
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", label + " · 调用", codexToolCallText(payload), lastTimestampMs, 0);
      } else if (payload.type === "function_call_output") {
        const label = payload.call_id && toolCallNames.has(String(payload.call_id))
          ? toolCallNames.get(String(payload.call_id))
          : "工具";
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", label + " · 输出", codexToolOutputText(payload), lastTimestampMs, 0);
      } else if (payload.type === "custom_tool_call") {
        const label = codexToolLabel(payload.name, "自定义工具");
        if (payload.call_id && payload.name) toolCallNames.set(String(payload.call_id), label);
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", label + " · 调用", codexToolCallText(payload), lastTimestampMs, 0);
      } else if (payload.type === "custom_tool_call_output") {
        const label = payload.call_id && toolCallNames.has(String(payload.call_id))
          ? toolCallNames.get(String(payload.call_id))
          : "自定义工具";
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", label + " · 输出", codexToolOutputText(payload), lastTimestampMs, 0);
      } else if (payload.type === "web_search_call") {
        const label = codexToolLabel(payload.action, "网页搜索");
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", label + " · 调用", codexToolCallText(payload), lastTimestampMs, 0);
      } else if (payload.type === "tool_search_call") {
        const label = "工具检索";
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", label + " · 调用", codexToolCallText(payload), lastTimestampMs, 0);
      } else if (payload.type === "tool_search_output") {
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", "工具检索 · 输出", codexToolOutputText(payload), lastTimestampMs, 0);
      } else if (payload.type === "image_generation_call") {
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", "图片生成 · 调用", codexToolCallText(payload), lastTimestampMs, 0);
      }
    }
  });

  if (!sessionId) return null;
  if (!firstUserMessage) firstUserMessage = firstObservedUserMessage;

  const indexRecord = indexMap.get(sessionId);
  if (indexRecord && indexRecord.updated_at) updatedAtMs = msFromTimestamp(indexRecord.updated_at);
  updatedAtMs = Math.max(updatedAtMs || 0, lastTimestampMs || 0, startedAtMs || 0);
  if (!updatedAtMs) updatedAtMs = lastTimestampMs || startedAtMs;
  if (!startedAtMs) startedAtMs = updatedAtMs;

  let titleRaw = indexRecord && indexRecord.thread_name ? String(indexRecord.thread_name) : "";
  if (!titleRaw || isBadTitle(titleRaw)) {
    titleRaw = firstUserMessage || lastUserMessage || path.basename(file);
  }

  const titleClean = normalizeText(titleRaw, 80) || path.basename(file);
  if (!firstUserMessage) firstUserMessage = titleClean;
  if (!lastUserMessage) lastUserMessage = firstUserMessage;

  let status = "unknown";
  if (lastLifecycle === "task_complete" || source === "archived_sessions") status = "completed";
  if (lastLifecycle === "task_started") status = "in_progress";

  const userTurns = rawResponseUserTurns.length
    ? rawResponseUserTurns
    : (fallbackUserTurns.length > eventUserTurns.length ? fallbackUserTurns : eventUserTurns);
  if (!userTurns.length && firstUserMessage) {
    userTurns.push({ index: 1, timestamp: isoDate(startedAtMs), text: normalizeText(firstUserMessage, 280) });
  }

  const project = projectName(cwd);
  const isSubagent = Boolean(parentThreadId);
  return makeRecord({
    source,
    source_kind: "codex",
    source_label: "Codex",
    session_type: isSubagent ? "subagent" : "main",
    session_type_label: isSubagent ? "子智能体任务" : "普通聊天",
    is_subagent: isSubagent,
    parent_thread_id: parentThreadId,
    forked_from_id: forkedFromId,
    agent_nickname: agentNickname,
    agent_role: agentRole,
    session_id: sessionId,
    title_raw: normalizeText(titleRaw, 200),
    title_clean: titleClean,
    started_at: isoDate(startedAtMs),
    updated_at: isoDate(updatedAtMs),
    status,
    cwd,
    project,
    first_user_message: normalizeText(firstUserMessage, 200),
    last_user_message: normalizeText(lastUserMessage, 200),
    last_agent_message: normalizeText(lastAgentMessage, 200),
    resume_command: `codex resume ${sessionId}`,
    turn_count: userTurns.length,
    user_turns: userTurns,
    transcript_items: transcriptItems,
    agent_messages: agentMessages
  });
}

async function parseClaudeSession(file) {
  const isSubagent = isClaudeSubagentFile(file);
  const parentThreadId = isSubagent ? inferClaudeParentThreadId(file) : "";
  let sessionId = "";
  let startedAtMs = 0;
  let updatedAtMs = 0;
  let lastTimestampMs = 0;
  let cwd = "";
  let firstUserMessage = "";
  let lastUserMessage = "";
  let lastAgentMessage = "";
  const transcriptItems = [];
  const transcriptSeen = new Set();
  const userTurns = [];
  const turnSeen = new Set();
  const agentMessages = [];

  await readJsonl(file, (item) => {
    if (!item || item.type === "file-history-snapshot" || item.type === "permission-mode") return;
    if (item.sessionId) sessionId = String(item.sessionId);
    if (item.cwd) cwd = String(item.cwd);
    if (item.timestamp) {
      lastTimestampMs = msFromTimestamp(item.timestamp);
      if (!startedAtMs) startedAtMs = lastTimestampMs;
      updatedAtMs = Math.max(updatedAtMs, lastTimestampMs);
    }

    if (item.type === "attachment") return;

    if (item.type === "user" && item.message) {
      const content = item.message.content;
      if (isClaudeToolResult(content)) {
        addTranscriptItem(transcriptItems, transcriptSeen, "tool", "工具结果", claudeToolResultText(content), lastTimestampMs, 1600);
        return;
      }
      const message = textFromClaudeContent(content);
      if (!message || isNoiseUserMessage(message)) return;
      if (!firstUserMessage) firstUserMessage = normalizeText(message, 500);
      lastUserMessage = normalizeText(message, 500);
      const turn = addUserTurn(userTurns, turnSeen, message, lastTimestampMs);
      addTranscriptItem(transcriptItems, transcriptSeen, "user", "用户", message, lastTimestampMs, 3200, turn ? { user_turn_index: turn.index } : {});
      return;
    }

    if (item.type === "assistant" && item.message) {
      for (const part of Array.isArray(item.message.content) ? item.message.content : [item.message.content]) {
        if (!part) continue;
        if (part.type === "text" && part.text) {
          const message = normalizeText(part.text, 900);
          if (message) {
            lastAgentMessage = normalizeText(message, 300);
            if (agentMessages.length < 24) agentMessages.push(message);
            addTranscriptItem(transcriptItems, transcriptSeen, "ai", "AI", message, lastTimestampMs, 3200);
          }
        } else if (part.type === "tool_use") {
          const label = part.name ? String(part.name) : "工具";
          const body = claudeToolUseText(part);
          addTranscriptItem(transcriptItems, transcriptSeen, "tool", label, body || label, lastTimestampMs, 1200);
        }
      }
    }
  });

  if (!sessionId) sessionId = path.basename(file, ".jsonl");
  if (!updatedAtMs) {
    try {
      const stat = await fs.stat(file);
      updatedAtMs = stat.mtimeMs;
      if (!startedAtMs) startedAtMs = stat.birthtimeMs || stat.mtimeMs;
    } catch {
      updatedAtMs = Date.now();
      startedAtMs = updatedAtMs;
    }
  }
  if (!startedAtMs) startedAtMs = updatedAtMs;

  const titleClean = normalizeText(firstUserMessage || lastUserMessage || path.basename(file, ".jsonl"), 80);
  if (!firstUserMessage) firstUserMessage = titleClean;
  if (!lastUserMessage) lastUserMessage = firstUserMessage;
  if (!userTurns.length && firstUserMessage) {
    userTurns.push({ index: 1, timestamp: isoDate(startedAtMs), text: normalizeText(firstUserMessage, 280) });
  }

  const project = projectName(cwd);
  return makeRecord({
    source: "claude_projects",
    source_kind: "claude_code",
    source_label: "Claude Code",
    session_type: isSubagent ? "subagent" : "main",
    session_type_label: isSubagent ? "子智能体任务" : "普通聊天",
    is_subagent: isSubagent,
    parent_thread_id: parentThreadId,
    agent_nickname: "",
    agent_role: "",
    session_id: sessionId,
    title_raw: normalizeText(titleClean, 200),
    title_clean: titleClean,
    started_at: isoDate(startedAtMs),
    updated_at: isoDate(updatedAtMs),
    status: "completed",
    cwd,
    project,
    first_user_message: normalizeText(firstUserMessage, 200),
    last_user_message: normalizeText(lastUserMessage, 200),
    last_agent_message: normalizeText(lastAgentMessage, 200),
    resume_command: `claude --resume ${sessionId}`,
    turn_count: userTurns.length,
    user_turns: userTurns,
    transcript_items: transcriptItems,
    agent_messages: agentMessages
  });
}

function isClaudeSubagentFile(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  return /\/subagents\/agent-[^/]+\.jsonl$/i.test(normalized) || /^agent-/i.test(path.basename(normalized));
}

function inferClaudeParentThreadId(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  const subagentIndex = parts.lastIndexOf("subagents");
  if (subagentIndex > 0) return parts[subagentIndex - 1] || "";
  return "";
}

function makeRecord(record) {
  const transcriptText = (record.transcript_items || []).map((item) => item.text).join(" ");
  const outlineText = (record.user_turns || []).map((item) => item.text).join(" ");
  const searchText = normalizeText([
    record.source_label,
    record.session_type_label,
    record.agent_nickname,
    record.agent_role,
    record.title_clean,
    record.cwd,
    record.project,
    record.first_user_message,
    record.last_user_message,
    record.last_agent_message,
    outlineText,
    transcriptText
  ].join(" "), 8000);

  return {
    ...record,
    message_count: Array.isArray(record.transcript_items) ? record.transcript_items.length : 0,
    search_text: searchText
  };
}

function summarizeRecord(record, sessionFile, detailId) {
  const sessionScope = String(sessionFile || "").startsWith("data/archived_sessions/")
    ? "archived"
    : "current";
  return {
    detail_id: detailId,
    session_id: record.session_id,
    title_raw: record.title_raw,
    title_clean: record.title_clean,
    updated_at: record.updated_at,
    started_at: record.started_at,
    status: record.status,
    source: record.source,
    source_kind: record.source_kind,
    source_label: record.source_label,
    session_type: record.session_type || "main",
    session_type_label: record.session_type_label || "普通聊天",
    is_subagent: Boolean(record.is_subagent),
    parent_thread_id: record.parent_thread_id || "",
    forked_from_id: record.forked_from_id || "",
    agent_nickname: record.agent_nickname || "",
    agent_role: record.agent_role || "",
    cwd: record.cwd,
    project: record.project,
    session_file: sessionFile,
    session_scope: sessionScope,
    session_scope_label: sessionScope === "archived" ? "归档历史" : "当前历史",
    first_user_message: record.first_user_message,
    last_user_message: record.last_user_message,
    last_agent_message: record.last_agent_message,
    resume_command: record.resume_command,
    turn_count: record.turn_count,
    message_count: record.message_count || 0,
    search_text: record.search_text,
    summary_status: "none",
    summary_delta_turns: 0,
    summary_generated_at: ""
  };
}

function recordRank(record) {
  return [
    Number(record.message_count || 0),
    Number(record.turn_count || 0),
    msFromTimestamp(record.updated_at),
    msFromTimestamp(record.started_at)
  ];
}

function isBetterRecord(candidate, current) {
  const left = recordRank(candidate);
  const right = recordRank(current);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return String(candidate.detail_id || "").localeCompare(String(current.detail_id || "")) > 0;
}

function consolidateCatalogRecords(records) {
  const groups = new Map();
  const passthrough = [];
  for (const record of records) {
    const isMainCodex = record.source_kind === "codex" && (record.session_type || "main") === "main" && record.session_id;
    if (!isMainCodex) {
      passthrough.push(record);
      continue;
    }
    const key = `${record.source_kind}:${record.session_id}`;
    const existing = groups.get(key);
    if (!existing || isBetterRecord(record, existing.best)) {
      groups.set(key, {
        best: record,
        count: existing ? existing.count + 1 : 1,
        alternates: existing ? [existing.best, ...existing.alternates] : []
      });
    } else {
      existing.count += 1;
      existing.alternates.push(record);
    }
  }

  return [
    ...passthrough,
    ...Array.from(groups.values()).map((group) => ({
      ...group.best,
      duplicate_count: group.count,
      alternate_detail_ids: group.alternates.map((item) => item.detail_id).filter(Boolean)
    }))
  ];
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

function detailPathFor(sourceKind, detailId) {
  return path.join(detailsRoot, safeFileName(sourceKind), `${safeFileName(detailId)}.json`);
}

function detailIdFor(relativePath, sessionId) {
  return `${safeFileName(sessionId)}--${sha256(relativePath).slice(0, 12)}`;
}

function dataRelativePath(filePath) {
  return "data/" + toPosix(path.relative(dataRoot, filePath));
}

function resolveSessionFilePath(sessionFile) {
  const normalized = toPosix(sessionFile);
  if (normalized === "data" || normalized.startsWith("data/")) {
    return path.resolve(dataRoot, normalized.slice("data/".length));
  }
  return path.resolve(repoRoot, sessionFile);
}

function replayOutputToString(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (typeof value.output === "string") return value.output;
    if (typeof value.stdout === "string") return value.stdout;
    if (typeof value.stderr === "string") return value.stderr;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

async function prepareReplayEditorSessionFile(sourcePath, detailId) {
  const stats = await fs.stat(sourcePath);
  const cacheKey = `${safeFileName(detailId)}--${stats.mtimeMs.toFixed(0)}--${stats.size}.jsonl`;
  const targetPath = path.join(replayEditorRoot, cacheKey);
  if (await exists(targetPath)) return targetPath;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const output = createWriteStream(targetPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: createReadStream(sourcePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        output.write("\n");
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (
          item &&
          item.type === "response_item" &&
          item.payload &&
          item.payload.type === "function_call_output" &&
          typeof item.payload.output !== "string"
        ) {
          item.payload.output = replayOutputToString(item.payload.output);
        }
        output.write(JSON.stringify(item) + "\n");
      } catch {
        output.write(line + "\n");
      }
    }
  } finally {
    rl.close();
    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.once("error", reject);
    });
  }

  return targetPath;
}

function codexRolloutIdFromFile(filePath) {
  const base = path.basename(String(filePath || ""), ".jsonl");
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : "";
}

function summaryPathFor(sourceKind, detailId) {
  return path.join(summariesRoot, safeFileName(sourceKind), `${safeFileName(detailId)}.json`);
}

function legacySummaryPathFor(sourceKind, detailId) {
  return path.join(legacySummariesRoot, safeFileName(sourceKind), `${safeFileName(detailId)}.json`);
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

async function loadSummaryConfig() {
  const fileEnv = parseEnvText(await fs.readFile(envLocalPath, "utf8").catch(() => ""));
  const read = (key) => fileEnv[key] || process.env[key] || "";
  return {
    baseUrl: read("SUMMARY_BASE_URL").replace(/\/+$/, ""),
    apiKey: read("SUMMARY_API_KEY"),
    model: read("SUMMARY_MODEL") || "kimi-for-coding",
    apiFormat: (read("SUMMARY_API_FORMAT") || "openai").toLowerCase(),
    maxInputChars: Number(read("SUMMARY_INPUT_MAX_CHARS") || 120000)
  };
}

function summaryLineForItem(item) {
  if (!item) return "";
  if (item.kind === "tool" || item.kind === "developer" || item.kind === "system") return "";
  const label = item.kind === "user"
    ? "用户"
    : item.kind === "developer"
      ? "开发者"
      : item.kind === "system"
        ? "系统"
        : "AI";
  const max = item.kind === "user" ? 2600 : 2200;
  const time = item.timestamp ? ` ${localTimeLabel(item.timestamp) || item.timestamp}` : "";
  return `[${label}${time}] ${normalizeBlockText(item.text, max)}`;
}

function makeSummaryPrompt(detail, projectContext, maxInputChars = 120000, detailId = "") {
  const items = Array.isArray(detail.transcript_items) ? detail.transcript_items : [];
  const itemLines = items.map(summaryLineForItem).filter(Boolean);
  const safeMaxChars = Number.isFinite(maxInputChars) && maxInputChars > 20000 ? maxInputChars : 120000;
  const latestTime = detail.updated_at || detail.last_timestamp || "";
  const githubRemote = projectContext && projectContext.github_remote ? projectContext.github_remote : "未确认";
  const topLevelEntries = projectContext && Array.isArray(projectContext.top_level_entries) ? projectContext.top_level_entries : [];
  const keyPaths = projectContext && Array.isArray(projectContext.key_paths) ? projectContext.key_paths : [];
  const projectContextLines = [
    `工作目录状态: ${(projectContext && projectContext.cwd_status) || "未确认"}`,
    `GitHub 仓库: ${githubRemote || "未确认"}`,
    topLevelEntries.length ? `顶层条目: ${topLevelEntries.join("；")}` : "顶层条目: 未识别到可用工程条目",
    keyPaths.length ? "候选关键路径:" : "候选关键路径: 未识别到关键工程文件"
  ];
  if (keyPaths.length) {
    for (const item of keyPaths) {
      projectContextLines.push(`- ${item.path} - ${item.role}`);
    }
  }
  const fixedLines = [
    `会话标题: ${detail.title_clean || detail.first_user_message || detail.session_id}`,
    `来源: ${detail.source_label || detail.source_kind}`,
    `source_kind: ${detail.source_kind || "-"}`,
    `session_id: ${detail.session_id || "-"}`,
    `工作目录: ${detail.cwd || "-"}`,
    `GitHub 仓库: ${githubRemote || "未确认"}`,
    `最新时间: ${localTimeLabel(latestTime) || latestTime || "-"}`,
    `轮数: ${detail.turn_count || 0}`,
    "",
    "请把下面这条 Codex/Claude Code 会话提炼成一个“上下文工程卡”。",
    "目标: 让用户在新对话里把这张卡交给新 agent 后，新 agent 能理解项目背景、用户需求、关键变更历史、已完成事实、工程入口和关键约束。",
    "输入只包含用户自然语言反馈/需求与 AI 自然语言回复；工具执行、日志、命令输出已经被刻意省略。",
    "输入策略: 默认给你这轮会话里可解析到的全部自然语言历史；如果历史过长，会只保留最新的连续片段，并在输入范围里说明。",
    "",
    "工程实况: 只能基于这里和会话内容写“工程目录和关键文件”，不要编造当前项目不存在的文件、目录或仓库地址。",
    ...projectContextLines,
    "请严格按这些标题输出 Markdown:",
    "## 上下文工程卡",
    "## 给我的 Codex 协作建议",
    "",
    "上下文工程卡压缩原则:",
    "- 只保留对新 agent 接续理解有用的信息，避免把完整聊天重新压缩成流水账。",
    "- 优先保留稳定事实、用户需求、用户偏好、关键决策、验证结果、已完成事项、文件/脚本/API/命令名称、会话定位。",
    "- 删除寒暄、重复纠偏、临时失败细节、未采纳方案、无后续价值的过程噪音。",
    "- 不要写确定性的“下一步计划”；用户会在新对话里指定真正下一步。只能给 2-4 个“可能继续方向”。",
    "- 上下文工程卡必须包含这些小标题: `项目背景`、`用户需求`、`工程目录和关键文件`、`关键变更历史`、`已完成事实`、`关键约束`、`重要定位`、`可能继续方向`。",
    "- 项目背景: 说明当前项目、代码库或文档对象是干嘛的。如果这条会话主要在处理文档、目录结构、接口配置或运营数据，而不是修改代码仓库，也要按实际对象描述，不要套用别的项目背景。",
    "- 用户需求: 汇总用户明确提出的目标、偏好、验收口径，避免泛泛而谈。",
    "- 工程目录和关键文件: 必须写工作目录 cwd、GitHub 仓库地址，以及关键文件/目录职责。优先使用上面的“工程实况”和会话内容；如果缺失，就写未确认，不要套用别的项目文件。",
    "- 关键变更历史: 只写 3-6 条关键大改动或关键决策。每条只包含时间范围、改动主题、结果/影响。不要按天流水账，不要分钟级时间线。",
    "- 关键变更历史要删除小修小补、重复试错、临时失败、用户多次纠偏的细节；只保留会影响后续判断的大节点。",
    "- 已完成事实: 只写已经实现、验证、提交、推送、清理过的事实；不要把推测或建议写成完成。",
    "- 关键约束: 包含数据口径、默认筛选、UI 密度、Kimi 输入只发自然语言、工具日志不发、安全/密钥边界等仍然重要的限制。",
    "- 重要定位: 必须包含 source_kind、session_id、cwd、latest_time，并说明只有需要核对细节或更新历史时才回查原始会话。",
    "- 如果输入范围提示历史被截断，只能总结保留下来的最新连续片段，必须在关键变更历史第一条说明“早期内容已被截断，本卡覆盖保留范围”，不要编造缺失的早期阶段。",
    "- 给我的 Codex 协作建议: 固定输出 `做得好的 1 条` 和 `可以优化的 2 条`。做得好的要说明为什么有效；每条可优化建议都要说明“问题表现 / 为什么会影响 Codex / 下次怎么改”。",
    "- 给我的 Codex 协作建议只评价用户如何更好地提需求、验收、纠偏、授权和管理上下文，不要针对项目本身继续出技术方案。"
  ];

  const fixedChars = fixedLines.join("\n").length + 800;
  const contentBudget = Math.max(12000, safeMaxChars - fixedChars);
  let selectedLines = itemLines;
  let usedChars = itemLines.join("\n\n").length;
  if (usedChars > contentBudget) {
    selectedLines = [];
    usedChars = 0;
    for (let index = itemLines.length - 1; index >= 0; index -= 1) {
      const next = itemLines[index];
      const nextCost = next.length + (selectedLines.length ? 2 : 0);
      if (selectedLines.length && usedChars + nextCost > contentBudget) break;
      selectedLines.unshift(next);
      usedChars += nextCost;
    }
    if (!selectedLines.length && itemLines.length) {
      const tail = itemLines[itemLines.length - 1];
      selectedLines = [tail.slice(Math.max(0, tail.length - contentBudget))];
      usedChars = selectedLines[0].length;
    }
  }

  const omittedItems = Math.max(0, itemLines.length - selectedLines.length);
  const inputMetadata = {
    total_items: itemLines.length,
    included_items: selectedLines.length,
    omitted_items: omittedItems,
    input_truncated: omittedItems > 0,
    max_input_chars: safeMaxChars,
    included_chars: usedChars,
    excluded_kinds: ["tool"]
  };

  const rangeLine = inputMetadata.input_truncated
    ? `输入范围: 历史过长，已保留最新 ${inputMetadata.included_items} 条可读消息，省略较早 ${inputMetadata.omitted_items} 条。`
    : `输入范围: 已包含全部 ${inputMetadata.included_items} 条可读消息。`;

  return {
    prompt: [
      ...fixedLines,
      "",
      rangeLine,
      "",
      "会话内容:",
      selectedLines.join("\n\n")
    ].join("\n"),
    inputMetadata
  };
}

function summaryInputHash(detail) {
  return sha256(JSON.stringify({
    session_id: detail.session_id,
    source_kind: detail.source_kind,
    turn_count: detail.turn_count,
    updated_at: detail.updated_at,
    first_user_message: detail.first_user_message,
    last_user_message: detail.last_user_message,
    transcript_items: (detail.transcript_items || []).map((item) => ({
      kind: item.kind,
      label: item.label,
      timestamp: item.timestamp,
      text: item.text
    }))
  }));
}

function withSummaryFreshness(summary, latestTurnCount) {
  if (!summary) return null;
  const summarized = Number(summary.summarized_turn_count || 0);
  const latest = Number(latestTurnCount || summary.latest_turn_count || 0);
  return {
    ...summary,
    latest_turn_count: latest,
    delta_turns: Math.max(0, latest - summarized)
  };
}

async function readSummary(sourceKind, detailId, latestTurnCount) {
  let summary = await loadJson(summaryPathFor(sourceKind, detailId), null);
  if (!summary) {
    summary = await loadJson(legacySummaryPathFor(sourceKind, detailId), null);
    if (summary) {
      await writeJson(summaryPathFor(sourceKind, detailId), summary);
    }
  }
  return withSummaryFreshness(summary, latestTurnCount);
}

async function callSummaryModel(config, prompt) {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    const missing = [];
    if (!config.baseUrl) missing.push("SUMMARY_BASE_URL");
    if (!config.apiKey) missing.push("SUMMARY_API_KEY");
    if (!config.model) missing.push("SUMMARY_MODEL");
    throw new Error(`Missing summary config: ${missing.join(", ")}`);
  }

  if (config.apiFormat === "anthropic") return callAnthropicSummaryModel(config, prompt);

  const url = chatCompletionsUrl(config.baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "你是一个上下文工程整理助手，擅长把长开发对话压缩成新 agent 可直接使用的结构化上下文。只输出用户要求的 Markdown。"
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 3200,
      temperature: 0.2
    })
  });

  const body = await response.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // Keep the raw body for a useful error below.
  }
  if (!response.ok) {
    const message = json && json.error && json.error.message ? json.error.message : body.slice(0, 500);
    throw new Error(`Summary model request failed (${response.status}): ${message}`);
  }

  const content = json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content
    : "";
  if (!content) throw new Error("Summary model returned empty content");
  return String(content).trim();
}

function chatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || "").replace(/\/+$/, "");
  return clean.endsWith("/v1") ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

function anthropicMessagesUrl(baseUrl) {
  const clean = String(baseUrl || "").replace(/\/+$/, "");
  return clean.endsWith("/v1") ? `${clean}/messages` : `${clean}/v1/messages`;
}

async function callAnthropicSummaryModel(config, prompt) {
  const response = await fetch(anthropicMessagesUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "Authorization": `Bearer ${config.apiKey}`,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 3200,
      system: "你是一个上下文工程整理助手，擅长把长开发对话压缩成新 agent 可直接使用的结构化上下文。只输出用户要求的 Markdown。",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  });

  const body = await response.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // Keep raw body for error reporting.
  }
  if (!response.ok) {
    const message = json && json.error && json.error.message ? json.error.message : body.slice(0, 500);
    throw new Error(`Summary model request failed (${response.status}): ${message}`);
  }

  const content = Array.isArray(json && json.content)
    ? json.content.map((item) => item && item.type === "text" ? item.text : "").filter(Boolean).join("\n")
    : "";
  if (!content) throw new Error("Summary model returned empty content");
  return String(content).trim();
}

async function generateSummary(sourceKind, detailId) {
  const detail = await loadJson(detailPathFor(sourceKind, detailId), null);
  if (!detail) {
    const error = new Error("Session detail not found");
    error.statusCode = 404;
    throw error;
  }

  const config = await loadSummaryConfig();
  const projectContext = await collectProjectPaths(detail.cwd || "");
  const { prompt, inputMetadata } = makeSummaryPrompt(detail, projectContext, config.maxInputChars, detailId);
  const summaryText = await callSummaryModel(config, prompt);
  const latestTurnCount = Number(detail.turn_count || 0);
  const result = {
    generated_at: new Date().toISOString(),
    model: config.model,
    source_kind: sourceKind,
    session_id: detail.session_id || detailId,
    detail_id: detailId,
    summarized_turn_count: latestTurnCount,
    latest_turn_count: latestTurnCount,
    delta_turns: 0,
    summary: summaryText,
    input_hash: summaryInputHash(detail),
    input_metadata: inputMetadata
  };
  await writeJson(summaryPathFor(sourceKind, detailId), result);
  return result;
}

async function buildCache({ exportFirst = false } = {}) {
  if (buildPromise) return buildPromise;
  buildPromise = (async () => {
    refreshState = {
      running: true,
      phase: exportFirst ? "exporting" : "indexing",
      last_error: "",
      started_at: new Date().toISOString(),
      finished_at: ""
    };

    try {
      if (exportFirst) await runExport();
      refreshState.phase = "indexing";

      const manifest = await loadJson(manifestPath, { version: cacheVersion, entries: {} });
      const manifestDataRoot = manifest.data_root ? path.resolve(String(manifest.data_root)) : "";
      const canReuseManifest = Number(manifest.version) === cacheVersion && manifestDataRoot === dataRoot;
      const previousEntries = canReuseManifest ? (manifest.entries || {}) : {};
      const nextEntries = {};
      const records = [];
      const indexMap = await readIndexMap();
      const sessionFiles = await getSessionFiles();
      let parsed = 0;
      let reused = 0;
      let sourceMaxMtimeMs = 0;
      const summaryMaxMtimeMs = await directoryMaxMtimeMs(summariesRoot, (item) => item.toLowerCase().endsWith(".json"));

      for (const item of sessionFiles) {
        const stat = await fs.stat(item.file);
        sourceMaxMtimeMs = Math.max(sourceMaxMtimeMs, stat.mtimeMs);
        const relativePath = dataRelativePath(item.file);
        const previous = previousEntries[relativePath];
        const detailExists = previous && previous.detail_path
          ? await exists(path.join(repoRoot, previous.detail_path))
          : false;

        if (
          previous &&
          previous.summary &&
          detailExists &&
          previous.source_kind === item.source_kind &&
          Number(previous.mtime_ms) === Number(stat.mtimeMs) &&
          Number(previous.length) === Number(stat.size)
        ) {
          records.push(previous.summary);
          nextEntries[relativePath] = previous;
          reused++;
          continue;
        }

        const record = item.source_kind === "claude_code"
          ? await parseClaudeSession(item.file)
          : await parseCodexSession(item.file, item.source, indexMap);

        if (!record) continue;
        const detailId = detailIdFor(relativePath, record.session_id);
        const detailPath = detailPathFor(record.source_kind, detailId);
        const detailRelativePath = toPosix(path.relative(repoRoot, detailPath));
        const detail = {
          ...record,
          detail_id: detailId,
          session_file: relativePath
        };
        await writeJson(detailPath, detail);
        const summary = summarizeRecord(record, relativePath, detailId);
        records.push(summary);
        nextEntries[relativePath] = {
          mtime_ms: stat.mtimeMs,
          length: stat.size,
          source_kind: record.source_kind,
          session_id: record.session_id,
          detail_id: detailId,
          detail_path: detailRelativePath,
          summary
        };
        parsed++;
      }

      const catalogRecords = records;

      for (const record of catalogRecords) {
        const summary = await readSummary(record.source_kind, record.detail_id, record.turn_count);
        record.summary_status = summary ? (summary.delta_turns > 0 ? "stale" : "fresh") : "none";
        record.summary_delta_turns = summary ? Number(summary.delta_turns || 0) : 0;
        record.summary_generated_at = summary ? String(summary.generated_at || "") : "";
      }

      catalogRecords.sort((a, b) => {
        const updatedDiff = msFromTimestamp(b.updated_at) - msFromTimestamp(a.updated_at);
        if (updatedDiff) return updatedDiff;
        return msFromTimestamp(b.started_at) - msFromTimestamp(a.started_at);
      });

      const sourceCounts = {};
      const statusCounts = {};
      const typeCounts = {};
      const scopeCounts = {};
      const summaryCounts = {};
      const projectCounts = new Map();
      for (const record of catalogRecords) {
        sourceCounts[record.source_kind] = (sourceCounts[record.source_kind] || 0) + 1;
        statusCounts[record.status] = (statusCounts[record.status] || 0) + 1;
        const sessionType = record.session_type || "main";
        typeCounts[sessionType] = (typeCounts[sessionType] || 0) + 1;
        const sessionScope = record.session_scope || "current";
        scopeCounts[sessionScope] = (scopeCounts[sessionScope] || 0) + 1;
        const summaryStatus = record.summary_status || "none";
        summaryCounts[summaryStatus] = (summaryCounts[summaryStatus] || 0) + 1;
        if (record.project) projectCounts.set(record.project, (projectCounts.get(record.project) || 0) + 1);
      }

      const catalog = {
        generated_at: new Date().toISOString(),
        data_root: dataRoot,
        total_sessions: catalogRecords.length,
        status_counts: {
          completed: statusCounts.completed || 0,
          in_progress: statusCounts.in_progress || 0,
          unknown: statusCounts.unknown || 0
        },
        source_counts: {
          codex: sourceCounts.codex || 0,
          claude_code: sourceCounts.claude_code || 0
        },
        type_counts: {
          main: typeCounts.main || 0,
          subagent: typeCounts.subagent || 0
        },
        scope_counts: {
          current: scopeCounts.current || 0,
          archived: scopeCounts.archived || 0
        },
        summary_counts: {
          none: summaryCounts.none || 0,
          fresh: summaryCounts.fresh || 0,
          stale: summaryCounts.stale || 0
        },
        projects: Array.from(projectCounts.entries())
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([project, count]) => ({ project, count })),
        sessions: catalogRecords,
        build_stats: {
          parsed,
          reused,
          raw_records: records.length,
          hidden_duplicate_main_sessions: 0
        }
      };

      await writeJson(indexPath, catalog);
      await writeJson(manifestPath, {
        version: cacheVersion,
        data_root: dataRoot,
        generated_at: catalog.generated_at,
        source_max_mtime_ms: sourceMaxMtimeMs,
        summary_max_mtime_ms: summaryMaxMtimeMs,
        entries: nextEntries
      });

      refreshState = {
        running: false,
        phase: "idle",
        last_error: "",
        started_at: refreshState.started_at,
        finished_at: new Date().toISOString()
      };
      return catalog;
    } catch (error) {
      refreshState = {
        running: false,
        phase: "error",
        last_error: error && error.stack ? error.stack : String(error),
        started_at: refreshState.started_at,
        finished_at: new Date().toISOString()
      };
      throw error;
    } finally {
      buildPromise = null;
    }
  })();
  return buildPromise;
}

async function runExport() {
  const psExe = await commandExists("pwsh") ? "pwsh" : "powershell";
  const scriptPath = path.join(repoRoot, "scripts", "Export-CodexSessions.ps1");
  await new Promise((resolve, reject) => {
    const child = spawn(psExe, ["-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      cwd: repoRoot,
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Export-CodexSessions.ps1 failed with code ${code}: ${stderr}`));
    });
  });
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("where.exe", [command], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function canConnect(host, candidatePort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: candidatePort });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function isPortAvailable(candidatePort) {
  if (await canConnect("127.0.0.1", candidatePort)) return false;
  if (await canConnect("::1", candidatePort)) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(candidatePort, "127.0.0.1");
  });
}

async function findReplayEditorPort() {
  const preferred = Number(process.env.CLAUDE_REPLAY_EDITOR_PORT || process.env.CLAUDE_REPLAY_PORT || 7340);
  for (let candidate = preferred; candidate < preferred + 20; candidate += 1) {
    if (await isPortAvailable(candidate)) return candidate;
  }
  throw new Error(`No free claude-replay editor port found near ${preferred}`);
}

async function waitForHttp(url, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`claude-replay editor did not become ready at ${url}`);
}

function isProcessRunning(child) {
  return child && child.exitCode === null && !child.killed;
}

async function openReplayEditor(sourceKind, detailId) {
  if (!(await commandExists("claude-replay"))) {
    const error = new Error("claude-replay command not found. Install it with: npm install -g claude-replay");
    error.statusCode = 501;
    throw error;
  }

  let resolvedDetailId = detailId;
  let detail = await loadJson(detailPathFor(sourceKind, resolvedDetailId), null);
  if (!detail) {
    const catalog = await loadJson(indexPath, {});
    const record = (catalog.sessions || []).find((item) =>
      item.source_kind === sourceKind &&
      (item.detail_id === detailId || item.session_id === detailId)
    );
    if (record && record.detail_id) {
      resolvedDetailId = record.detail_id;
      detail = await loadJson(detailPathFor(sourceKind, resolvedDetailId), null);
    }
  }
  if (!detail) {
    const error = new Error("Session detail not found");
    error.statusCode = 404;
    throw error;
  }
  if (!detail.session_file) {
    const error = new Error("This session has no source jsonl path");
    error.statusCode = 400;
    throw error;
  }

  const sessionPath = resolveSessionFilePath(detail.session_file);
  if (!sessionPath.startsWith(dataRoot + path.sep) && sessionPath !== dataRoot) {
    const error = new Error("Session source path is outside the configured data root");
    error.statusCode = 400;
    throw error;
  }
  if (!(await exists(sessionPath))) {
    const error = new Error(`Session source file not found: ${detail.session_file}`);
    error.statusCode = 404;
    throw error;
  }

  const replaySessionPath = sourceKind === "codex"
    ? await prepareReplayEditorSessionFile(sessionPath, resolvedDetailId)
    : sessionPath;

  const key = `${sourceKind}:${resolvedDetailId}`;
  const existing = replayEditorProcesses.get(key);
  if (existing && isProcessRunning(existing.child)) {
    return {
      url: existing.load_url,
      base_url: existing.url,
      port: existing.port,
      reused: true,
      detail_id: resolvedDetailId,
      session_file: detail.session_file,
      replay_session_file: existing.replay_session_file
    };
  }

  const editorPort = await findReplayEditorPort();
  const url = `http://127.0.0.1:${editorPort}/`;
  const loadUrl = `${url}?load=${encodeURIComponent(replaySessionPath)}`;
  const args = ["/c", "claude-replay", "editor", replaySessionPath, "--port", String(editorPort), "--host", "127.0.0.1"];
  const child = spawn("cmd.exe", args, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  replayEditorProcesses.set(key, {
    child,
    url,
    load_url: loadUrl,
    port: editorPort,
    detail_id: resolvedDetailId,
    session_file: detail.session_file,
    replay_session_file: replaySessionPath
  });
  try {
    await waitForHttp(url);
  } catch (error) {
    replayEditorProcesses.delete(key);
    try { child.kill(); } catch {}
    throw error;
  }
  return {
    url: loadUrl,
    base_url: url,
    port: editorPort,
    reused: false,
    detail_id: resolvedDetailId,
    session_file: detail.session_file,
    replay_session_file: replaySessionPath
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sourceStatus() {
  const manifest = await loadJson(manifestPath, {});
  const manifestDataRoot = manifest.data_root ? path.resolve(String(manifest.data_root)) : "";
  const dataRootChanged = manifestDataRoot !== dataRoot;
  const sourceMaxMtimeMs = await directoryMaxMtimeMs(dataRoot, (item) => item.toLowerCase().endsWith(".jsonl"));
  const summaryMaxMtimeMs = await directoryMaxMtimeMs(summariesRoot, (item) => item.toLowerCase().endsWith(".json"));
  const sessionDataChanged = dataRootChanged || !manifest.source_max_mtime_ms || sourceMaxMtimeMs > Number(manifest.source_max_mtime_ms);
  const summaryDataChanged = manifest.summary_max_mtime_ms
    ? summaryMaxMtimeMs > Number(manifest.summary_max_mtime_ms)
    : summaryMaxMtimeMs > 0;
  return {
    data_root: dataRoot,
    source_max_mtime_ms: sourceMaxMtimeMs,
    summary_max_mtime_ms: summaryMaxMtimeMs,
    has_new_data: Boolean(sessionDataChanged || summaryDataChanged)
  };
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function sendFile(res, filePath, contentType) {
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Length": body.length
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/Session-Explorer.html")) {
      await sendFile(res, htmlPath, "text/html; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/index") {
      const source = await sourceStatus();
      if (!(await exists(indexPath)) || source.has_new_data) await buildCache({ exportFirst: false });
      const catalog = await loadJson(indexPath, null);
      sendJson(res, catalog ? 200 : 503, catalog || { error: "index unavailable", refresh: refreshState });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/session/")) {
      const parts = url.pathname.split("/").map(decodeURIComponent);
      const sourceKind = parts[3] || "";
      const summaryRoute = parts[parts.length - 1] === "summary";
      const detailId = (summaryRoute ? parts.slice(4, -1) : parts.slice(4)).join("/") || "";
      if (summaryRoute) {
        const detail = await loadJson(detailPathFor(sourceKind, detailId), null);
        const summary = await readSummary(sourceKind, detailId, detail ? detail.turn_count : 0);
        sendJson(res, summary ? 200 : 404, summary || { error: "summary not found" });
        return;
      }
      const detailPath = detailPathFor(sourceKind, detailId);
      const detail = await loadJson(detailPath, null);
      sendJson(res, detail ? 200 : 404, detail || { error: "session detail not found" });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/session/") && url.pathname.endsWith("/summary")) {
      const parts = url.pathname.split("/").map(decodeURIComponent);
      const sourceKind = parts[3] || "";
      const detailId = parts.slice(4, -1).join("/") || "";
      const summary = await generateSummary(sourceKind, detailId);
      sendJson(res, 200, summary);
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/session/") && url.pathname.endsWith("/replay-editor")) {
      const parts = url.pathname.split("/").map(decodeURIComponent);
      const sourceKind = parts[3] || "";
      const detailId = parts.slice(4, -1).join("/") || "";
      const result = await openReplayEditor(sourceKind, detailId);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      if (!refreshState.running) {
        buildCache({ exportFirst: true }).catch(() => {});
      }
      sendJson(res, 202, refreshState);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const catalog = await loadJson(indexPath, {});
      const source = await sourceStatus();
      sendJson(res, 200, {
        ...refreshState,
        generated_at: catalog.generated_at || "",
        total_sessions: catalog.total_sessions || 0,
        source_counts: catalog.source_counts || {},
        build_stats: catalog.build_stats || {},
        ...source
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    sendJson(res, error && error.statusCode ? error.statusCode : 500, {
      error: error && error.message ? error.message : String(error),
      refresh: refreshState
    });
  }
}

createServer((req, res) => {
  handleRequest(req, res);
}).listen(port, "127.0.0.1", () => {
  console.log(`Session Explorer listening on http://127.0.0.1:${port}/`);
  if (!buildPromise) {
    exists(indexPath).then((hasIndex) => {
      if (!hasIndex) buildCache({ exportFirst: false }).catch((error) => console.error(error));
    });
  }
});
