export interface KvsAdapter {
  /** Write host → s3Prefix mapping into the CloudFront KVS. */
  put(host: string, s3Prefix: string): Promise<void>;
}
