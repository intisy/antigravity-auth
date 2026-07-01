// Universal plugin contract via core's shared test-kit. configName is the
// provider's real config file (antigravity.json), which differs from the package.
import { runPluginContract } from "../../core/src/testing.js";

runPluginContract({
  name: "antigravity-auth",
  entry: "dist/index.js",
  configName: "antigravity",
  app: "both",
  commands: ["antigravity-config", "antigravity-accounts"],
  deploy: "load",
  actions: [["accounts"]],
  readme: true,
});
