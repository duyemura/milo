// One-off: publish the page-clone reconstruction to mygymseo.com staging,
// reusing Milo's real publish adapters. Isolated — imports the package, edits nothing.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishStaging, createRealS3Adapter, createRealKvsAdapter } from "../packages/publish/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const distDir = path.join(__dirname, arg("dist", "dist"));

const config = {
  slug: arg("slug", "page-clone-torrance-hero"),
  bucket: "pushpress-marketing-dev",
  region: process.env.S3_REGION || "us-east-1",
  kvsArn: process.env.CLOUDFRONT_KVS_ARN,
  siteDomain: "mygymseo.com",
  awsProfile: process.env.AWS_PROFILE || "unicorn",
  gymJsonPath: "",
  publishJsonPath: "",
};

if (!config.kvsArn) throw new Error("CLOUDFRONT_KVS_ARN not set");

const s3 = createRealS3Adapter({ bucket: config.bucket, region: config.region, awsProfile: config.awsProfile });
const kvs = createRealKvsAdapter({ kvsArn: config.kvsArn, region: config.region, awsProfile: config.awsProfile });

await publishStaging({ config, distDir, s3, kvs });
console.log(`\n→ clone:   https://${config.slug}-staging.${config.siteDomain}/`);
console.log(`→ compare: https://${config.slug}-staging.${config.siteDomain}/compare.html`);
