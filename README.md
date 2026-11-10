# @easel-sh/sdk

Deploy and manage apps on [Easel](https://easel.sh) from any JavaScript
runtime: Node.js 20+, Bun, Deno, and edge runtimes. The main entry uses only
`fetch` and Web Crypto.

```sh
npm install @easel-sh/sdk
```

```ts
import { createClient } from "@easel-sh/sdk";

const easel = createClient({ token: process.env.EASEL_TOKEN! });

const project = await easel.projects.ensure("trip-planner");
await easel.env.upsert(project.id, [
  { key: "DATABASE_URL", value: process.env.DATABASE_URL!, target: ["production"] },
]);

const deployment = await easel.deployments.create({
  project: project.id,
  target: "production",
  files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
});
const ready = await easel.deployments.wait(deployment.id);
console.log(ready.primaryUrl);
```

`@easel-sh/sdk/node` adds `deployDirectory()`, `collectDeployFiles()`, and
`createSourceArchiveTgz()` for deploying a folder on disk.

Full documentation: [easel.sh/docs/sdk](https://easel.sh/docs/sdk).
