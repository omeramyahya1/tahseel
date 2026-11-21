import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    starlight({
      title: "Tahseel Docs",
      sidebar: [{ label: "Getting started", slug: "docs" }],
    }),
  ],
});
