import { randomUUID } from "node:crypto";
import path from "node:path";
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
import type { SpawnFn } from "./runner.ts";

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
  sp?: SpawnFn;
}): Promise<void> {
  const { db, job, site, distDir, log, sp } = opts;

  if (site.seedType === "clone") {
    if (job.type !== "deploy-staging") {
      throw new Error("promote/rollback aren't supported for clone seeds yet — deploy-staging only.");
    }
    if (!sp) throw new Error("clone deploy requires a process spawner.");
    const company = await db
      .selectFrom("companies")
      .select("name")
      .where("id", "=", site.companyId)
      .executeTakeFirstOrThrow();
    const slug =
      site.slug ??
      company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") +
        "-" +
        randomUUID().slice(0, 6);
    const cloneCli = path.join(opts.config.repoRoot, "packages/clone-engine/src/cli.ts");
    await log(`$ node packages/clone-engine/src/cli.ts deploy --dist dist/ --slug ${slug}`);
    const r = await sp("node", [cloneCli, "deploy", "--dist", distDir, "--slug", slug], {
      cwd: opts.config.repoRoot,
      env: {},
    });
    if (r.code !== 0) throw new Error(`clone deploy exited ${r.code}`);

    const url = `https://${slug}-staging.mygymseo.com`;
    await db
      .insertInto("deploys")
      .values({
        id: randomUUID(),
        workspaceId: site.workspaceId,
        companyId: site.companyId,
        siteId: site.id,
        env: "staging",
        versionId: null,
        url,
        status: "deployed",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await db
      .updateTable("sites")
      .set({ slug, status: "deployed", stage: "in-review" })
      .where("id", "=", site.id)
      .execute();
    await log(`live: ${url}`);
    return;
  }

  const config = await resolveOrInitConfig({ gymJsonPath: opts.gymJsonPath });
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
