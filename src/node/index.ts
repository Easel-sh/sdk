import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EaselClient } from "../client.js";
import type { Deployment, DeploymentMeta, DeploymentTarget } from "../types.js";
import { collectDeployFiles, createSourceArchiveTgz } from "./collect-deploy-files.js";

export { collectDeployFiles, createSourceArchiveTgz, type CollectedDeployFile } from "./collect-deploy-files.js";
export { collectDetectionInput, type DetectionInput } from "./collect-detection-input.js";

/**
 * Deploy a directory on this machine: collect its files (skipping the default
 * ignore list and `.easelignore`), pack them into one gzip tarball and send it
 * in a single request.
 */
export async function deployDirectory(
  client: EaselClient,
  input: {
    dir: string;
    project: string;
    target?: DeploymentTarget;
    meta?: DeploymentMeta;
    idempotencyKey?: string;
  },
): Promise<Deployment> {
  const files = await collectDeployFiles({ root: input.dir });
  const staging = await mkdtemp(join(tmpdir(), "easel-sdk-"));
  try {
    const archivePath = join(staging, "source.tgz");
    await createSourceArchiveTgz(files, archivePath);
    return await client.deployments.create({
      project: input.project,
      target: input.target,
      meta: input.meta,
      archive: new Uint8Array(await readFile(archivePath)),
      idempotencyKey: input.idempotencyKey,
    });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
