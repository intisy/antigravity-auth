# antigravity-auth

[![npm version](https://img.shields.io/npm/v/antigravity-auth.svg)](https://www.npmjs.com/package/antigravity-auth)
[![npm downloads](https://img.shields.io/npm/dm/antigravity-auth.svg)](https://www.npmjs.com/package/antigravity-auth)
[![CI](https://github.com/intisy-ai/antigravity-auth/actions/workflows/publish.yml/badge.svg)](https://github.com/intisy-ai/antigravity-auth/actions/workflows/publish.yml)

Google Antigravity provider for OpenCode and Claude Code, built as a thin driver on top of [core-auth](https://github.com/intisy-ai/core-auth). core-auth owns all the generic work — multi-account storage, selection/rotation, token refresh, and rate-limit/cooldown state — while this package supplies only the antigravity specifics: the request/response transform, the Cloud Code Assist endpoints, and the Google OAuth login. The same account pool is shared by both OpenCode and Claude Code.

## Under-the-Hood Architecture

```mermaid
flowchart TD
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
        STORE[(core-auth-accounts.json)]
        MGR <--> STORE
    end

    HANDLE -->|acquire / reportRateLimit / reportSuccess| MGR
    LOGIN -->|addAccount| MGR
```

The driver maps a requested model to a lane (`claude`, `gemini-antigravity`, `gemini-cli`), asks `AccountManager` for an account + fresh access token, builds the upstream request with the reused transform layer, and dispatches with endpoint fallback. On a rate-limit it reports the reset time to core and rotates; on success it transforms the response back to the caller's format.

## Structure

- `src/`
  - `index.ts` — OpenCode entry (the core-auth provider plugin)
  - `handler.ts` — Claude Code entry (`handle()` for the claude-code-loader proxy)
  - `cli.ts` — `antigravity login | list | remove`
  - `driver/` — `index.ts` (driver + `handle`), `config.ts`, `lanes.ts`, `migrate.ts`, `models.ts`, `login.ts`
  - `antigravity/oauth.ts`, `plugin/{request,request-helpers,project,transform/*,core/streaming/*,...}.ts` — the reused antigravity transform/request layer
  - `core-auth/` — the core-auth library (git submodule, bundled into the output)
- `dist/` — bundled `index.js`, `handler.js`, `cli.js` (generated; not committed)

## Installation

### Via plugin-updater (primary)

Add an entry to `plugins.json` and let the loader clone + build it:

```json
{ "name": "antigravity-auth", "url": "https://github.com/intisy-ai/antigravity-auth", "enabled": true, "autoUpdate": true }
```

Then log in (writes to the shared core-auth account pool, used by both apps):

```bash
node ~/.claude/repos/antigravity-auth/dist/cli.js login
```

In OpenCode, run `oc auth login` once and pick **Antigravity** so OpenCode routes through the provider.

### Via npm

```bash
npm install -g antigravity-auth
antigravity login
```

## Configuration

Config is read from, in order of preference:

1. `~/.config/opencode/config/antigravity-auth.json` (Claude: `~/.claude/config/antigravity-auth.json`)
2. `~/.config/opencode/antigravity-auth.json` (fallback)

```json
{
  "account_selection_strategy": "hybrid",
  "logging": true
}
```

Accounts live in the core-auth store at `<configDir>/config/core-auth-accounts.json`. The OAuth client id/secret are read from `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` (env) when set, falling back to the built-in values.

## Logging

Logs are written to `<configDir>/logs/YYYY-MM-DD/antigravity-auth-HH-MM-SS.log`. Set `"logging": false` in the config file to disable.

## License

MIT
