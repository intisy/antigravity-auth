// @ts-nocheck
// OpenCode entry: the antigravity provider, running on core-auth via src/driver.
// IMPORTANT: export ONLY the provider plugin. OpenCode invokes every export of a
// plugin module as a hook, so any extra export (e.g. OAuth helpers) would be run
// as a bogus plugin and can break registration — keep this file to one export.

export { AntigravityProvider } from "./driver/index.js";
