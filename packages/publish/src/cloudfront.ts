export interface KvsAdapter {
  /** Write host → s3Prefix mapping into the CloudFront KVS. */
  put(host: string, s3Prefix: string): Promise<void>;
}

import {
  CloudFrontKeyValueStoreClient,
  PutKeyCommand,
  DescribeKeyValueStoreCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import "@aws-sdk/signature-v4-crt"; // Register SigV4a signer required by CloudFront KVS

export function createRealKvsAdapter(opts: {
  kvsArn: string;
  region: string;
  awsProfile: string;
}): KvsAdapter {
  const credentials = fromIni({ profile: opts.awsProfile });
  const client = new CloudFrontKeyValueStoreClient({
    region: opts.region,
    credentials,
  });

  return {
    async put(host: string, s3Prefix: string): Promise<void> {
      const describe = await client.send(
        new DescribeKeyValueStoreCommand({ KvsARN: opts.kvsArn }),
      );
      await client.send(
        new PutKeyCommand({
          KvsARN: opts.kvsArn,
          IfMatch: describe.ETag,
          Key: host,
          Value: s3Prefix,
        }),
      );
    },
  };
}
