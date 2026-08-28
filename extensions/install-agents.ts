/**
 * install-agents — seeds the bundled agent definitions into the pi user
 * agent pool (`~/.pi/agent/agents/`) so they are available to the `subagent`
 * tool from the (prerequisite) pi-agents extension.
 *
 * Idempotent & non-destructive: an agent file is only written if it does not
 * already exist. Existing agent definitions (including user customizations)
 * are never overwritten.
 *
 * pi's core package loader does not natively bundle agent definitions
 * (packages support extensions/skills/prompts/themes), so this extension is
 * the distribution mechanism. See README.md.
 */

import { mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Directory of THIS extension file (works under jiti ESM and CJS). */
function moduleDir(): string {
  try {
    // jiti/ESM: import.meta tersedia
    if (typeof import.meta !== "undefined" && typeof import.meta.url === "string") {
      return fileURLToPath(new URL(".", import.meta.url));
    }
  } catch {
    /* lanjut ke CJS */
  }
  try {
    // CJS
    return typeof __dirname === "string" ? __dirname : process.cwd();
  } catch {
    return process.cwd();
  }
}

export default function (pi: ExtensionAPI) {
  console.error("[pi-agentic-harness] install-agents factory LOADED");
  pi.on("session_start", () => {
    try {
      const agentsSrc = resolve(moduleDir(), "..", "agents");
      const agentsDest = join(getAgentDir(), "agents");
      if (!existsSync(agentsSrc)) {
        console.error(`[pi-agentic-harness] seed skipped: agents dir tak ada di ${agentsSrc}`);
        return;
      }

      mkdirSync(agentsDest, { recursive: true });
      let installed = 0;
      let skipped = 0;
      for (const file of readdirSync(agentsSrc)) {
        if (!file.endsWith(".md")) continue;
        if (!statSync(join(agentsSrc, file)).isFile()) continue;
        const dest = join(agentsDest, file);
        if (existsSync(dest)) {
          skipped++; // jangan timpa definisi yang sudah ada/kustom
          continue;
        }
        copyFileSync(join(agentsSrc, file), dest);
        installed++;
      }
      if (installed > 0) {
        console.log(`[pi-agentic-harness] installed ${installed} agent definition(s) into ${agentsDest}`);
      }
    } catch (err) {
      console.error("[pi-agentic-harness] failed to seed agents:", err);
    }
  });
}