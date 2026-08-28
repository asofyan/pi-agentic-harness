# pi-agentic-harness

Fryxell-style **harness backbone** for [pi](https://github.com/earendil-works/pi): an explicit
plan → execute → verify → communicate loop for work delegated to sub-agents.

Inspired by Scott Fryxell's *[The Harness Is the Thing](https://scott-fryxell.github.io/blog/the-harness-is-the-thing/)*
and the *[Building an Advanced Agentic Harness](https://data4sci.com/blog/building-an-advanced-agentic-harness)*
series (planner/worker/critic separation, DAG plans, budgets, verification hierarchy).

## What's inside

| Part | What it does |
|------|--------------|
| `extensions/index.ts` | Registers **5 harness tools** callable by the orchestrator *and* any sub-agent: `harness_plan_open`, `harness_add_node`, `harness_node_status`, `harness_plan_status`, `harness_plan_report`. Plan state lives in `<project>/.harness/plan.json` (atomic writes + cross-process file lock). |
| `extensions/install-agents.ts` | Seeds `agents/*.md` into `~/.pi/agent/agents/` on `session_start`. **Idempotent & non-destructive** — existing agent files (incl. your customizations) are never overwritten. |
| `agents/*.md` | **8 phase-aligned sub-agent definitions** mapping to the Fryxell arc, each with a mandatory *Harness Protocol* (open plan → mark node running → do work → mark done/failed with evidence): |

| Agent | Phase (Fryxell) | Model (default) |
|-------|-----------------|-----------------|
| `explorer`, `librarian` | **explore** — research & mapping | deepseek-v4-flash |
| `oracle` | **plan** (architecture) + **critic** (review/simplify) | deepseek-v4-pro |
| `fixer`, `designer` | **worker** — execute plan nodes | flash / minimax-m2.7 |
| `observer` | **critic** — visual evidence | deepseek-v4-flash |
| `council` | **critic** — multi-model consensus | deepseek-v4-pro |
| `promoter` | **promoter** — communicate the finished work | deepseek-v4-pro |

The Harness Protocol is enforced inside every agent definition: agents must locate
their node, mark it `running`, complete it with evidence (`path:line`, test output),
or mark it `failed` with an error class (`transient | tool_misuse | missing_info | fatal`).

## Install

Requires the **prerequisite** `pi-agents` extension — it provides the `subagent`
tool and discovers agent definitions from `~/.pi/agent/agents/`. Install it first,
then:

```bash
pi install git:github.com/asofyan/pi-agentic-harness@v1.0.0
```

Try without installing (temporary):

```bash
pi -e git:github.com/asofyan/pi-agentic-harness
```

After install, `/reload` (or restart pi). The 8 agents appear in the `subagent` tool
(`/agents` lists them), and the `harness_*` tools are available to every session.

> **Security:** pi packages run with full system access. Review the source
> (`extensions/`, `agents/`) before installing. Plan files are written inside
> your project (`.harness/`).

## Usage — the loop

Every non-trivial task flows through the harness:

```
1. harness_plan_open      goal = one sentence
2. harness_add_node       nodes per phase: explore → plan → worker → critic → promoter (deps + acceptance)
3. subagent()             delegate each node to the matching agent; agents mark their own status
                          via harness_node_status (running → done | failed | blocked)
4. harness_plan_status    check pressure; > 0.9 → degrade to cheap checks (tests/lint)
5. harness_plan_report    finalize .harness/report.md, then @promoter communicates the work
```

Failure policy mirrors the data4sci harness: `missing_info` → **re-plan** (not blind
retry), `transient` → retry with backoff, `tool_misuse` → self-correct, `fatal` → halt.

## Development / layout

```
pi-agentic-harness/
├── package.json          # pi manifest (extensions only; agents ship as data + installer)
├── extensions/
│   ├── index.ts          # harness_* tools
│   └── install-agents.ts # agent seeding (idempotent)
└── agents/               # 8 agent definitions (source of truth)
```

Start `pi`, create a plan, and inspect `.harness/plan.json` while work proceeds —
the plan is an auditable trace of every step, who did it, and its evidence.

## License

MIT — see [LICENSE](LICENSE). Agent definitions and harness tooling are original
work of this repository's author; the ideas (planner/worker/critic, DAG plans,
budgets, verification hierarchy) follow the openly-published work of
[Scott Fryxell](https://scott-fryxell.github.io/blog/the-harness-is-the-thing/)
and [Data For Science](https://data4sci.com/blog/building-an-advanced-agentic-harness).