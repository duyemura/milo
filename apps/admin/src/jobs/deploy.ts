import { randomUUID } from "node:crypto";
import {
  createRealKvsAdapter,
  createRealS3Adapter,
  publishProduction,
  publishRollback,
  publishStaging,
  resolveOrInitConfig,
} from "@milo/publish";
import type { AdminDb } from "../db/index.ts";
import type { AdminConfig } from "../config.ts";
import type { JobRow, SiteRow } from "../db/types.ts";

/**
 * Deploy/promote/rollback via the battle-tested @milo/publish (NOT the spike's deploy.mjs —
 * per the consolidation map, v2's publish is the capable one). Site slug comes from the
 * publish.json that resolveOrInitConfig materializes next to gym.json.
 */
export async function runDeploy(opts: {
  db: AdminDb;
  config: AdminConfig;
  job: JobRow;
  site: SiteRow;
  distDir: string;
  gymJsonPath: string;
  log: (line: string) => Promise<void>;
}): Promise<void> {
  const { db, job, site, distDir, gymJsonPath, log } = opts;

  const config = await resolveOrInitConfig({ gymJsonPath });
  const s3 = createRealS3Adapter({ bucket: config.bucket, region: config.region, awsProfile: config.awsProfile });
  const kvs = createRealKvsAdapter({ kvsArn: config.kvsArn, region: config.region, awsProfile: config.awsProfile });

  const env = job.type === "promote" || job.type === "rollback" ? "production" : "staging";
  const host = `${config.slug}-${env}.${config.siteDomain}`;
  const url = `https://${host}`;

  if (job.type === "deploy-staging") {
    await log(`publishing staging → ${url}`);
    await publishStaging({ config, distDir, s3, kvs });
  } else if (job.type === "promote") {
    await log(`promoting staging → production on ${url}`);
    await publishProduction({ config, s3, kvs });
  } else {
    const payload = JSON.parse(job.payload) as { versionId?: string; env?: "staging" | "production" };
    const targetEnv = payload.env ?? "production";
    await log(`rolling back ${targetEnv}${payload.versionId ? ` to ${payload.versionId}` : ""}`);
    await publishRollback({ config, env: targetEnv, versionId: payload.versionId, s3, kvs });
  }

  await db
    .insertInto("deploys")
    .values({
      id: randomUUID(),
      workspaceId: site.workspaceId,
      companyId: site.companyId,
      siteId: site.id,
      env,
      versionId: null,
      url,
      status: job.type === "rollback" ? "rolled-back" : "deployed",
      createdAt: new Date().toISOString(),
    })
    .execute();

  // Stage follows the deploy: staging deploy/rollback → in-review; promote → live.
  const stage = job.type === "promote" ? "live" : "in-review";
  await db
    .updateTable("sites")
    .set({ slug: config.slug, status: "deployed", stage })
    .where("id", "=", site.id)
    .execute();

  await log(`live: ${url}`);
}
