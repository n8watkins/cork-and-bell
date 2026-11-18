import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    // The party kit's Worker code imports "cloudflare:workers": run it through vitest so a test can
    // stand that module in (test/worker.test.js), instead of handing it to Node, which cannot load it.
    server: { deps: { inline: ["n8-party-games"] } },
  },
});
