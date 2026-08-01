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

export interface DeployOpts {
  distDir: string;
  slug: string;
}

export async function deploy(opts: DeployOpts): Promise<void> {
  const config = {
    slug: opts.slug,
    bucket: "pushpress-marketing-dev",
    region: process.env.S3_REGION ?? "us-east-1",
    kvsArn: process.env.CLOUDFRONT_KVS_ARN,
    siteDomain: "mygymseo.com",
    awsProfile: process.env.AWS_PROFILE ?? "unicorn",
    gymJsonPath: "",
    publishJsonPath: "",
  };

  if (!config.kvsArn) throw new Error("CLOUDFRONT_KVS_ARN not set");

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

  console.log(`\n→ clone:   https://${config.slug}-staging.${config.siteDomain}/`);
  console.log(`→ compare: https://${config.slug}-staging.${config.siteDomain}/compare.html`);
}
