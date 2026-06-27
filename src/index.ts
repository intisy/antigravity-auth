// @ts-nocheck
// OpenCode entry. Export ONLY the provider plugin: OpenCode runs every export as a hook, so any extra export would register as a bogus plugin and can break registration.
// Slash-command / config invocations shell back in as `node <bundle> <action>`; handle those first and exit so they never register the provider.
import { deployCommands, ensureConfig } from "../core/src/index.js";
import { ANTIGRAVITY_COMMANDS, maybeRunCli } from "./commands.js";

if (await maybeRunCli("antigravity")) {
  process.exit(0);
}
try {
  deployCommands("antigravity-auth", ANTIGRAVITY_COMMANDS);
  ensureConfig("antigravity", { account_selection_strategy: "hybrid", logging: true });
} catch {
  /* best-effort */
}

export { AntigravityProvider } from "./driver/index.js";
