import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
export type ManagedEndpoint = { hostname: string; port: number; protocol: "http" | "https" | "tcp" };
export type ManagedApproval = {
  allowed: boolean;
  rationale: string;
  approvedBy?: "reviewer" | "human";
};
type ManagedInput = {
  command: string;
  cwd: string;
  justification: string;
  toolCallId: string;
  sessionId: string;
  turn?: number;
  timeout?: number;
  endpoint?: ManagedEndpoint;
};

const DIRECTORY = "/home/node/.pi/agent/managed-approvals";
const ROOTS = Symbol.for("pi-subagents:approval-origins");
const CHILDREN = Symbol.for("pi-subagents:approval-child-sessions");
const tokenPattern = /^[a-f0-9]{32}$/;
const sessionPattern = /^[a-f0-9-]{36}$/i;
// The one Unix-shell argument limit is smaller than this message bound. The
// remainder accommodates the command justification and JSON string encoding.
const MAX_BYTES = 1024 * 1024;

type Origin = Readonly<{ sessionId: string; address: string }>;
type Child = Readonly<{ origin?: Origin; agent?: string }>;
type Forwarded = Omit<ManagedInput, "sessionId" | "turn"> & {
  childSessionId: string;
  turn: number;
  agent?: string;
};

const shared = globalThis as Record<symbol, unknown>;

export function managedChild(sessionId: string): Child | undefined {
  return (shared[CHILDREN] as Map<string, Child> | undefined)?.get(sessionId);
}

function validOrigin(origin: Origin | undefined): origin is Origin {
  return Boolean(origin && sessionPattern.test(origin.sessionId) && tokenPattern.test(origin.address));
}

function socketPath(directory: string, origin: Origin): string {
  return join(directory, origin.address + ".sock");
}

function denied(rationale: string): ManagedApproval {
  return { allowed: false, rationale };
}

function validInput(input: unknown): input is Forwarded {
  if (!input || typeof input !== "object") return false;
  const { command, justification, cwd, toolCallId, timeout, childSessionId, agent, turn, endpoint } = input as Partial<Forwarded>;
  return typeof command === "string" && typeof justification === "string" &&
    typeof cwd === "string" && cwd.startsWith("/") && typeof toolCallId === "string" && toolCallId.length > 0 &&
    typeof childSessionId === "string" && sessionPattern.test(childSessionId) &&
    typeof turn === "number" && Number.isSafeInteger(turn) && turn >= 0 &&
    (agent === undefined || typeof agent === "string") &&
    (endpoint === undefined || Boolean(endpoint && typeof endpoint.hostname === "string" &&
      /^[a-z0-9.:[\]-]+$/i.test(endpoint.hostname) && Number.isInteger(endpoint.port) &&
      endpoint.port > 0 && endpoint.port <= 65535 && ["http", "https", "tcp"].includes(endpoint.protocol))) &&
    (timeout === undefined || (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 1));
}

async function readJson(stream: AsyncIterable<Buffer | string>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error("Delegated approval request is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

export async function serveChildApprovals(
  sessionId: string,
  approve: (input: Forwarded, signal: AbortSignal) => Promise<ManagedApproval>,
  directory = DIRECTORY,
): Promise<() => void> {
  const origin = Object.freeze({ sessionId, address: randomBytes(16).toString("hex") });
  if (!validOrigin(origin)) throw new Error("Cannot start delegated approvals for an invalid session.");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory) {
    throw new Error("Delegated approvals need a private session directory.");
  }
  const lifetime = new AbortController();
  const server = createServer(async (req, res) => {
    const disconnect = new AbortController();
    res.once("close", () => disconnect.abort());
    const signal = AbortSignal.any([lifetime.signal, disconnect.signal]);
    let decision: ManagedApproval;
    try {
      const input = req.method === "POST" && req.url === "/" ? await readJson(req) : undefined;
      decision = validInput(input) && input.childSessionId !== sessionId && !signal.aborted
        ? await approve(input, signal) : denied("Invalid delegated approval request.");
    } catch {
      decision = denied("Delegated approval could not be completed.");
    }
    if (!signal.aborted) res.end(JSON.stringify(decision));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath(directory, origin), () => {
      server.off("error", reject);
      resolve();
    });
  });
  const roots = (shared[ROOTS] ??= new Map()) as Map<string, Origin>;
  if (roots.has(sessionId)) {
    server.close();
    throw new Error("Another approval owner is active for this session.");
  }
  roots.set(sessionId, origin);
  server.unref();
  return () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    if (roots.get(sessionId) === origin) roots.delete(sessionId);
    server.close();
    server.closeAllConnections();
  };
}

export async function requestChildApproval(
  child: Child,
  input: ManagedInput,
  signal?: AbortSignal,
  directory = DIRECTORY,
): Promise<ManagedApproval> {
  const { origin, agent } = child;
  if (!validOrigin(origin) || origin.sessionId === input.sessionId) {
    return denied("The originating session for this delegated approval is unavailable.");
  }
  const body = JSON.stringify({
    command: input.command, cwd: input.cwd, justification: input.justification, timeout: input.timeout,
    toolCallId: input.toolCallId, childSessionId: input.sessionId, turn: input.turn, endpoint: input.endpoint, agent,
  });
  if (Buffer.byteLength(body) > MAX_BYTES) return denied("Delegated approval request is too large.");
  try {
    return await new Promise<ManagedApproval>((resolve, reject) => {
      const req = request({
        socketPath: socketPath(directory, origin), path: "/", method: "POST", agent: false, signal,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (res) => {
        void readJson(res).then((value) => {
          const result = value as Partial<ManagedApproval> | null;
          if (result?.allowed === true && typeof result.rationale === "string" &&
              (result.approvedBy === "human" || result.approvedBy === "reviewer")) {
            resolve({ allowed: true, rationale: result.rationale, approvedBy: result.approvedBy });
          } else {
            resolve(denied(typeof result?.rationale === "string" ? result.rationale : "Invalid delegated approval response."));
          }
        }, reject);
      });
      req.once("error", reject);
      req.end(body);
    });
  } catch {
    return denied("The originating session is unavailable or the delegated approval was cancelled.");
  }
}
