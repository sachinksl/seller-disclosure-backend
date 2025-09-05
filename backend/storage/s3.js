// backend/storage/s3.js
const {
    S3Client,
    HeadBucketCommand, CreateBucketCommand  } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  
  const REGION = process.env.AWS_REGION || 'us-east-1';
  const ENDPOINT = process.env.S3_ENDPOINT || undefined; // e.g. http://localhost:9000 for MinIO
  const FORCE_PATH_STYLE =
    String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';
  
  const s3 = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: FORCE_PATH_STYLE || undefined,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
  });
  
  async function putObject({ bucket, key, body, contentType }) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }
  
  async function presignGet({ bucket, key, expiresIn = 60 * 5 }) {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(s3, cmd, { expiresIn });
  }
  
  async function deleteObject({ bucket, key }) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  
  module.exports = { s3, putObject, presignGet, deleteObject };
  

  async function ensureBucket(name) {
    if (!name) throw new Error('Missing S3_BUCKET env');
    try {
      await s3.send(new HeadBucketCommand({ Bucket: name }));
    } catch (err) {
      if (err.$metadata?.httpStatusCode === 404 || err.Code === 'NotFound') {
        await s3.send(new CreateBucketCommand({ Bucket: name }));
      } else {
        throw err;
      }
    }
  }