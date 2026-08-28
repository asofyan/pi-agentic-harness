/**
 * agentic-harness — "tulang punggung" (backbone) ala Fryxell/data4sci.
 *
 * Memberi loop eksplisit untuk pekerjaan yang didelegasikan ke sub agents:
 *   plan (DAG) -> node status -> budget/pressure -> verification -> report.
 *
 * Tools (dipanggil oleh sub agents & orchestrator):
 *   harness_plan_open      mulai/atur ulang satu plan aktif per project
 *   harness_add_node       tambah node (fase Fryxell: explore/plan/worker/critic/promoter)
 *   harness_node_status    transisi status node + catat bukti + tagih budget
 *   harness_plan_status    snapshot plan: node, completion, budget pressure, guidance
 *   harness_plan_report    finalisasi: tulis .harness/report.md (fase promoter)
 *
 * Penyimpanan: <cwd>/.harness/plan.json + report.md. Ditulis atomik + file lock
 * agar aman dipakai sub agents paralel (proses pi terpisah).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------- state ---

interface PlanNode {
  id: string;
  role: string; // explore | plan | worker | critic | promoter | support
  task: string;
  deps: string[];
  acceptance?: string;
  model?: string;
  status: string; // pending | running | done | failed | blocked
  note?: string;
  evidence?: string;
}

interface Plan {
  id: string;
  goal: string;
  createdAt: number;
  nodes: Record<string, PlanNode>;
  trace: Array<{ ts: number; nodeId: string; status: string; note?: string }>;
  budget: {
    maxCalls: number;
    callsUsed: number;
    maxSeconds: number;
    startedAt: number;
  };
}

const DEFAULTS = { maxCalls: 40, maxSeconds: 3600 };

function harnessDir(cwd: string) {
  return path.join(cwd, ".harness");
}
function planPath(cwd: string) {
  return path.join(harnessDir(cwd), "plan.json");
}
function lockPath(cwd: string) {
  return path.join(harnessDir(cwd), ".lock");
}

/** File lock sederhana antir-proses (sub agents = proses pi terpisah). */
async function withLock<T>(cwd: string, fn: () => T): Promise<T> {
  const lock = lockPath(cwd);
  fs.mkdirSync(harnessDir(cwd), { recursive: true });
  const deadline = Date.now() + 5000;
  let fd: number | undefined;
  while (!fd) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch {
      if (Date.now() > deadline) throw new Error("harness: timeout menunggu file lock");
      await new Promise((r) => setTimeout(r, 50));
      if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 10_000) {
        try { fs.unlinkSync(lock); } catch { /* ignore */ }
      }
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

function loadPlan(cwd: string): Plan {
  const p = planPath(cwd);
  if (!fs.existsSync(p)) {
    throw new Error(
      "Belum ada plan. Panggil harness_plan_open dulu (atau minta orchestrator membuat plan).",
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Plan;
}

function savePlan(cwd: string, plan: Plan) {
  fs.mkdirSync(harnessDir(cwd), { recursive: true });
  const tmp = planPath(cwd) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, planPath(cwd));
}

interface Snapshot {
  planId: string;
  goal: string;
  nodes: Array<{ id: string; role: string; status: string; deps: string[]; note?: string }>;
  done: number;
  total: number;
  pct: number;
  failed: string[];
  blocked: string[];
  pressure: number;
  guidance: string;
  budget: { callsUsed: number; maxCalls: number };
  traceTail: number[];
}

function pressureOf(plan: Plan): number {
  const b = plan.budget;
  const calls = b.callsUsed / b.maxCalls;
  const time = (Date.now() - b.startedAt) / 1000 / b.maxSeconds;
  return Math.max(calls, time);
}

function guidance(p: number): string {
  if (p >= 1.0) return "HALT: budget habis. Berhenti, laporkan hasil parsial.";
  if (p > 0.9) return "DEGRADE: skor. Lewati LLM judge/critic mahal; pakai cek deterministik (test/lint) saja.";
  if (p > 0.7) return "WASPADA: hemat. Prioritaskan node kritikal; hindari riset ekspansif.";
  return "OK: jalankan plan penuh.";
}

function snapshot(cwd: string): Snapshot {
  const plan = loadPlan(cwd);
  const nodes = Object.values(plan.nodes);
  const done = nodes.filter((n) => n.status === "done").length;
  const p = pressureOf(plan);
  return {
    planId: plan.id,
    goal: plan.goal,
    nodes: nodes.map((n) => ({ id: n.id, role: n.role, status: n.status, deps: n.deps, note: n.note })),
    done,
    total: nodes.length,
    pct: nodes.length ? Math.round((done / nodes.length) * 100) : 0,
    failed: nodes.filter((n) => n.status === "failed").map((n) => n.id),
    blocked: nodes.filter((n) => n.status === "blocked").map((n) => n.id),
    pressure: p,
    guidance: guidance(p),
    budget: { callsUsed: plan.budget.callsUsed, maxCalls: plan.budget.maxCalls },
    traceTail: plan.trace.slice(-8).map((t) => t.ts),
  };
}

// ---------------------------------------------------------------- tools ---

const RoleEnum = StringEnum(["explore", "plan", "worker", "critic", "promoter", "support"] as const);
const StatusEnum = StringEnum(["running", "done", "failed", "blocked"] as const);

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

function hasCycle(nodes: Record<string, PlanNode>, id: string, deps: string[]): boolean {
  // cek sederhana: deps harus ada, dan tidak boleh mengarah balik ke id
  for (const d of deps) {
    if (!nodes[d]) throw new Error(`harness_add_node: deps tak dikenal: ${d}`);
    if (d === id) throw new Error(`harness_add_node: cycle — node tidak boleh tergantung pada dirinya sendiri: ${id}`);
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  console.error("[dbg] factory ENTERED, typeof import.meta =", typeof import.meta);
  pi.registerTool({
    name: "harness_plan_open",
    label: "Harness: Open Plan",
    description: [
      "Mulai (atau reset) plan aktif untuk project ini. Bisa dipanggil berulang saat plan berubah.",
      "Goal = satu kalimat hasil akhir. Semua phase Fryxell: explore -> plan -> worker -> critic -> promoter.",
    ].join(" "),
    promptSnippet: "Open/reset the active harness plan with a goal",
    promptGuidelines: [
      "Use harness_plan_open at the start of any non-trivial task to create the plan before delegating.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Hasil akhir yang ingin dicapai, satu kalimat." }),
      reset: Type.Optional(Type.Boolean({ description: "true = buang plan lama & mulai baru." })),
      maxCalls: Type.Optional(Type.Number({ description: "Batasan unit kerja/budget (default 40)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return withLock(ctx.cwd, () => {
        const now = Date.now();
        const plan: Plan = {
          id: `plan-${now.toString(36)}`,
          goal: params.goal,
          createdAt: now,
          nodes: {},
          trace: [],
          budget: {
            maxCalls: params.maxCalls ?? DEFAULTS.maxCalls,
            callsUsed: 0,
            maxSeconds: DEFAULTS.maxSeconds,
            startedAt: now,
          },
        };
        savePlan(ctx.cwd, plan);
        return text(`Plan dibuka: ${plan.id}\n${JSON.stringify(snapshot(ctx.cwd), null, 2)}`);
      });
    },
  });

  pi.registerTool({
    name: "harness_add_node",
    label: "Harness: Add Node",
    description: "Tambah satu node (unit kerja) ke plan dengan fase role, dependensi, dan acceptance.",
    promptSnippet: "Add a node to the plan (role, deps, acceptance)",
    parameters: Type.Object({
      nodeId: Type.String({ description: "id unik node, kebab-case (mis. impl-auth)" }),
      role: RoleEnum,
      task: Type.String({ description: "Apa yang harus dikerjakan node ini." }),
      deps: Type.Optional(Type.Array(Type.String(), { description: "nodeId yang harus selesai dulu" })),
      acceptance: Type.Optional(Type.String({ description: "Kriteria terima / bukti selesai (mis. test hijau)" })),
      model: Type.Optional(Type.String({ description: "Model yang akan mengerjakan (opsional)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return withLock(ctx.cwd, () => {
        const plan = loadPlan(ctx.cwd);
        if (plan.nodes[params.nodeId]) {
          return text(`Node ${params.nodeId} sudah ada — skip. ${JSON.stringify(snapshot(ctx.cwd))}`);
        }
        hasCycle(plan.nodes, params.nodeId, params.deps ?? []);
        plan.nodes[params.nodeId] = {
          id: params.nodeId,
          role: params.role,
          task: params.task,
          deps: params.deps ?? [],
          acceptance: params.acceptance,
          model: params.model,
          status: "pending",
        };
        savePlan(ctx.cwd, plan);
        return text(`Node ${params.nodeId} (${params.role}) ditambahkan. ${JSON.stringify(snapshot(ctx.cwd))}`);
      });
    },
  });

  pi.registerTool({
    name: "harness_node_status",
    label: "Harness: Node Status",
    description: [
      "Transisi status node: running -> done | failed | blocked. Wajib memberi note (bukti/alasannya).",
      "done = job benar-benar selesai (acceptance terpenuhi). failed = sertakan kelas error:",
      "transient | tool_misuse | missing_info | fatal. Tagih 1 unit budget per panggilan.",
    ].join(" "),
    promptSnippet: "Mark a plan node running/done/failed/blocked with evidence",
    promptGuidelines: [
      "Use harness_node_status to record your node's status with concrete evidence (file:line, test output) before finishing your reply.",
    ],
    parameters: Type.Object({
      nodeId: Type.String(),
      status: StatusEnum,
      note: Type.String({ description: "Bukti / alasan singkat (wajib) — path:line, output test, atau kelas error." }),
      evidence: Type.Optional(Type.String({ description: "Bukti detail opsional" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return withLock(ctx.cwd, () => {
        const plan = loadPlan(ctx.cwd);
        const node = plan.nodes[params.nodeId];
        if (!node) throw new Error(`harness_node_status: node tak dikenal: ${params.nodeId}`);
        node.status = params.status;
        node.note = params.note;
        if (params.evidence) node.evidence = params.evidence;
        plan.budget.callsUsed += 1;
        plan.trace.push({ ts: Date.now(), nodeId: node.id, status: params.status, note: params.note });
        savePlan(ctx.cwd, plan);
        return text(`Node ${params.nodeId} -> ${params.status}. ${JSON.stringify(snapshot(ctx.cwd))}`);
      });
    },
  });

  pi.registerTool({
    name: "harness_plan_status",
    label: "Harness: Plan Status",
    description: "Snapshot plan aktif: semua node + status, completion %, pressure budget, dan guidance degradasi.",
    promptSnippet: "Show the current harness plan snapshot",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return text("Plan aktif:\n" + JSON.stringify(snapshot(ctx.cwd), null, 2));
    },
  });

  pi.registerTool({
    name: "harness_plan_report",
    label: "Harness: Report",
    description: [
      "Finalisasi pekerjaan: tulis .harness/report.md (ringkasan goal, node, status, budget, trace).",
      "Dipakai fase promoter (komunikasi hasil) & verifikasi akhir oleh critic/orchestrator.",
    ].join(" "),
    promptSnippet: "Finalize the plan: write the harness report",
    parameters: Type.Object({
      outcome: Type.Optional(Type.String({ description: "Hasil akhir / keputusan (ok, failed_verify, dst.)" })),
      communicate: Type.Optional(Type.Boolean({ description: "true = tambahkan draft komunikasi/announcement" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return withLock(ctx.cwd, () => {
        const snap = snapshot(ctx.cwd);
        const s = snap;
        const report = [
          `# Harness Report — ${s.planId}`,
          "",
          `**Goal:** ${s.goal}`,
          `**Outcome:** ${params.outcome ?? "—"}`,
          `**Completion:** ${s.pct}% (${s.done}/${s.total}) — budget ${s.budget.callsUsed}/${s.budget.maxCalls}, pressure ${s.pressure.toFixed(2)}`,
          "",
          "## Nodes",
          "",
          ...s.nodes.map((n) => `- [${n.status}] \`${n.id}\` (${n.role})${n.note ? ` — ${n.note}` : ""}${n.deps.length ? ` (deps: ${n.deps.join(", ")})` : ""}`),
          "",
          `**Guidance:** ${s.guidance}`,
        ];
        if (params.communicate) {
          report.push("", "## Komunikasi (promoter)", "", "- (menunggu draf promoter: changelog / release note / announcement)");
        }
        const out = report.join("\n");
        fs.mkdirSync(harnessDir(ctx.cwd), { recursive: true });
        fs.writeFileSync(path.join(harnessDir(ctx.cwd), "report.md"), out);
        return text(out);
      });
    },
  });

    // ------------------------------------------------------------------ #
  // Agent seeding — distribusikan definisi agent (agents/*.md) ke pool
  // agent user (~/.pi/agent/agents/). Idempotent & non-destruktif: file
  // yang sudah ada (termasuk kustomisasi user) TIDAK pernah ditimpa.
  // ------------------------------------------------------------------ #

  // Seeding dijalankan saat factory dimuat (berlaku di SEMUA mode, termasuk
  // -p/--no-session) dan diulang saat session_start (idempotent).
  seedAgents();
  pi.on("session_start", seedAgents);
}

/**
 * Directory of this extension file (works under jiti ESM and CJS).
 */
function moduleDir(): string {
  try {
    if (typeof import.meta !== "undefined" && typeof import.meta.url === "string") {
      return fileURLToPath(new URL(".", import.meta.url));
    }
  } catch {
    /* fall through to CJS */
  }
  try {
    return typeof __dirname === "string" ? __dirname : process.cwd();
  } catch {
    return process.cwd();
  }
}

/** Salin definisi agent bawaan ke pool agent user bila belum ada. */
function seedAgents(): void {
  console.error("[dbg] seedAgents ENTERED");
  try {
    const agentsSrc = path.resolve(moduleDir(), "..", "agents");
    const agentsDest = path.join(getAgentDir(), "agents");
    if (!fs.existsSync(agentsSrc)) {
      console.error(`[pi-agentic-harness] seed skipped: agents dir not found at ${agentsSrc}`);
      return;
    }
    fs.mkdirSync(agentsDest, { recursive: true });
    let installed = 0;
    for (const file of fs.readdirSync(agentsSrc)) {
      if (!file.endsWith(".md")) continue;
      if (!fs.statSync(path.join(agentsSrc, file)).isFile()) continue;
      const dest = path.join(agentsDest, file);
      if (fs.existsSync(dest)) continue; // never overwrite existing definitions
      fs.copyFileSync(path.join(agentsSrc, file), dest);
      installed++;
    }
    if (installed > 0) {
      console.log(`[pi-agentic-harness] installed ${installed} agent definition(s) into ${agentsDest}`);
    }
  } catch (err) {
    console.error("[pi-agentic-harness] failed to seed agents:", err);
  }
}
