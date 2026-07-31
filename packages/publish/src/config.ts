import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSlug, generateSuffix } from "./slugify.ts";

export interface PublishConfig {
  slug: string;
  bucket: string;
  region: string;
  kvsArn: string;
  siteDomain: string;
  awsProfile: string;
  gymJsonPath: string;
  publishJsonPath: string;
}

interface PublishJson {
  slug: string;
  bucket?: string;
  kvsArn: string;
  siteDomain?: string;
}

const DEFAULTS = {
  bucket: "pushpress-marketing-dev",
  region: "us-east-1",
  siteDomain: "mygymseo.com",
  awsProfile: "unicorn",
};

export async function resolveOrInitConfig(opts: {
  gymJsonPath: string;
  kvsArnOverride?: string;
  bucketOverride?: string;
  regionOverride?: string;
  siteDomainOverride?: string;
  awsProfileOverride?: string;
}): Promise<PublishConfig> {
  const gymJsonPath = path.resolve(opts.gymJsonPath);
  const publishJsonPath = path.join(path.dirname(gymJsonPath), "publish.json");

  let pj: PublishJson;

  if (existsSync(publishJsonPath)) {
    pj = JSON.parse(await readFile(publishJsonPath, "utf-8")) as PublishJson;
  } else {
    const gymRaw = JSON.parse(await readFile(gymJsonPath, "utf-8")) as Record<string, unknown>;
    const identity = gymRaw["identity"] as Record<string, unknown> | undefined;
    const gymName = (identity?.["name"] as string | undefined) ?? "gym";
    const kvsArn =
      opts.kvsArnOverride ?? process.env["CLOUDFRONT_KVS_ARN"];
    if (!kvsArn) {
      throw new Error(
        "CLOUDFRONT_KVS_ARN env var is required on first publish. " +
          "Set it or pass --kvs-arn <arn>.",
      );
    }
    const slug = buildSlug(gymName, generateSuffix());
    pj = { slug, kvsArn };
    await writeFile(publishJsonPath, JSON.stringify({ slug, kvsArn }, null, 2) + "\n");
    console.log(`Created publish.json — slug: ${slug}`);
  }

  return {
    slug: pj.slug,
    bucket:
      opts.bucketOverride ?? pj.bucket ?? process.env["S3_BUCKET"] ?? DEFAULTS.bucket,
    region: opts.regionOverride ?? process.env["S3_REGION"] ?? DEFAULTS.region,
    kvsArn:
      opts.kvsArnOverride ??
      pj.kvsArn ??
      process.env["CLOUDFRONT_KVS_ARN"] ??
      "",
    siteDomain:
      opts.siteDomainOverride ??
      pj.siteDomain ??
      process.env["SITE_DOMAIN"] ??
      DEFAULTS.siteDomain,
    awsProfile:
      opts.awsProfileOverride ??
      process.env["AWS_PROFILE"] ??
      DEFAULTS.awsProfile,
    gymJsonPath,
    publishJsonPath,
  };
}
