// @ts-nocheck
// OpenCode entry. Export ONLY the provider plugin: OpenCode runs every export as a hook, so any extra export would register as a bogus plugin and can break registration.
// Slash-command / config invocations shell back in as `node <bundle> <action>`; handle those first and exit so they never register the provider.
import { deployCommands, defineConfig, defineReadme, maybeRunReadmeCli } from "../core/src/index.js";
import { ANTIGRAVITY_COMMANDS, maybeRunCli } from "./commands.js";
import { DEFAULT_CONFIG } from "./plugin/config/schema.js";

// Register the FULL config schema (the driver's own DEFAULT_CONFIG — the same defaults
// its loader applies) BEFORE the CLI guard, so `config schema`/`config list`, the
// `/config` command, and the loader Configure editor expose every option (not just a
// couple). Writes no file on load. `logging` is core's logger toggle (kept).
defineConfig("antigravity", { ...DEFAULT_CONFIG, logging: true });

defineReadme({
  description:
    "Google Antigravity provider for OpenCode and Claude Code, built as a thin driver on top of [core-auth](https://github.com/intisy-ai/core-auth). core-auth owns all the generic work — multi-account storage, selection/rotation, token refresh, and rate-limit/cooldown state — while this package supplies only the antigravity specifics: the request/response transform, the Cloud Code Assist endpoints, and the Google OAuth login. The same account pool is shared by both OpenCode and Claude Code.",
  architecture: `flowchart TD
    subgraph Apps
        OC[OpenCode] -->|auth hook loader.fetch| HANDLE
        CC[Claude Code] -->|claude-code-loader proxy| HANDLE
    end

    subgraph Driver [antigravity-auth driver]
        HANDLE["handle(request, ctx)"]
        LOGIN["login - CLI: antigravity login"]
        TRANSFORM["prepareAntigravityRequest / transformAntigravityResponse"]
        LANES["laneFor / parseRateLimitReason"]
        HANDLE --> LANES
        HANDLE --> TRANSFORM
        TRANSFORM -->|POST + endpoint fallback| GOOGLE[(Cloud Code Assist API)]
        LOGIN -->|Google PKCE OAuth| GOOGLE
    end

    subgraph Core [core-auth library bundled in]
        MGR[AccountManager]
        STORE[(accounts.json)]
        MGR <--> STORE
    end

    HANDLE -->|acquire / reportRateLimit / reportSuccess| MGR
    LOGIN -->|addAccount| MGR`,
  structure: {
    src: [
      "`index.ts` — OpenCode entry (the core-auth provider plugin)",
      "`handler.ts` — Claude Code entry (`handle()` for the claude-code-loader proxy)",
      "`cli.ts` — `antigravity login | list | remove`",
      "`driver/` — `index.ts` (driver + `handle`), `config.ts`, `lanes.ts`, `migrate.ts`, `models.ts`, `login.ts`",
      "`antigravity/oauth.ts`, `plugin/{request,request-helpers,project,transform/*,core/streaming/*,...}.ts` — the reused antigravity transform/request layer",
      "`commands.ts` — cross-app slash-command definitions + their CLI actions",
      "`core-auth/` — the core-auth library (git submodule, bundled into the output)",
      "`core/` — shared [`intisy-ai/core`](https://github.com/intisy-ai/core) submodule (config + logging + command framework), bundled in",
    ],
    dist: [
      "bundled `index.js`, `handler.js`, `cli.js` (generated; not committed)",
    ],
  },
  commands: ANTIGRAVITY_COMMANDS,
  dependencies: ["core", "core-auth", "sync-bridge"],
  extraSections: [
    {
      id: "arch-detail",
      title: "Driver Detail",
      after: "architecture",
      body: "The driver maps a requested model to a lane (`claude`, `gemini-antigravity`, `gemini-cli`), asks `AccountManager` for an account + fresh access token, builds the upstream request with the reused transform layer, and dispatches with endpoint fallback. On a rate-limit it reports the reset time to core and rotates; on success it transforms the response back to the caller's format.",
    },
  ],
});

if (maybeRunReadmeCli("antigravity")) process.exit(0);

if (await maybeRunCli("antigravity")) {
  process.exit(0);
}
try {
  deployCommands("antigravity-auth", ANTIGRAVITY_COMMANDS);
} catch {
  /* best-effort */
}

export { AntigravityProvider } from "./driver/index.js";
