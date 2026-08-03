/**
 * One-shot deploy to mygymseo.com staging.
 *
 * Ported from page-clone-spike/deploy.mjs. Changes:
 *   - CLI arg parsing → structured `opts`.
 *   - Relative "../packages/publish/src/index.ts" import → workspace package "@milo/publish".
 *   - All config values (bucket, region, siteDomain, etc.) preserved identically.
 *   - The `if (!config.kvsArn) throw` guard preserved.
 *
 * DO NOT call this function without human authorization — it writes to S3.
 */
import { publishStaging, createRealS3Adapter, createRealKvsAdapter } from "@milo/publish";
import fs from "node:fs";

export interface DeployOpts {
  distDir: string;
  slug: string;
}

export async function deploy(opts: DeployOpts): Promise<void> {
  const kvsArn = process.env.CLOUDFRONT_KVS_ARN;
  if (!kvsArn) throw new Error("CLOUDFRONT_KVS_ARN not set");

  const config = {
    slug: opts.slug,
    bucket: "pushpress-marketing-dev",
    region: process.env.S3_REGION ?? "us-east-1",
    kvsArn,
    siteDomain: "mygymseo.com",
    awsProfile: process.env.AWS_PROFILE ?? "unicorn",
    gymJsonPath: "",
    publishJsonPath: "",
  };

  const s3 = createRealS3Adapter({
    bucket: config.bucket,
    region: config.region,
    awsProfile: config.awsProfile,
  });
  const kvs = createRealKvsAdapter({
    kvsArn: config.kvsArn,
    region: config.region,
    awsProfile: config.awsProfile,
  });

  await publishStaging({ config, distDir: opts.distDir, s3, kvs });

  // The assembled site lives in S3/CloudFront now — the on-disk dist dir is
  // ephemeral. Remove it immediately so builds don't accumulate full-site/
  // copies on the host. Kept on publish failure (retry/debug).
  fs.rmSync(opts.distDir, { recursive: true, force: true });

  console.log(`\n→ clone:   https://${config.slug}-staging.${config.siteDomain}/`);
  console.log(`→ compare: https://${config.slug}-staging.${config.siteDomain}/compare.html`);
}
