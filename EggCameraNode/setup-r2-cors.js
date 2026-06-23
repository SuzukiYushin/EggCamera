// CWD に依存せず、このスクリプト自身の隣の .env を確実に読む
// （リポジトリ root から `node EggCameraNode/setup-r2-cors.js` と叩いても動くように）
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } = require('@aws-sdk/client-s3');

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

async function main() {
    await r2.send(new PutBucketCorsCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        CORSConfiguration: {
            CORSRules: [{
                AllowedOrigins: [process.env.PAGES_BASE_URL],
                AllowedMethods: ['GET', 'HEAD'],
                AllowedHeaders: ['*'],
                MaxAgeSeconds: 86400,
            }],
        },
    }));

    const res = await r2.send(new GetBucketCorsCommand({ Bucket: process.env.R2_BUCKET_NAME }));
    console.log('CORS set:', JSON.stringify(res.CORSRules, null, 2));
}

main().catch(console.error);
