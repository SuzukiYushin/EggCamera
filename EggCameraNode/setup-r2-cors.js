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

// 管理画面ブラウザからの直PUT（再送/再合成）を許可するオリジン。
// 書き込み認可は pre-signed 署名で担保されるため、ここは CORS プリフライト通過用。
// 限定したい場合は .env の ADMIN_CORS_ORIGINS（カンマ区切り, 例
// "http://192.168.0.10:3001,http://localhost:3001"）を設定する。未設定なら '*'。
const ADMIN_CORS_ORIGINS = (process.env.ADMIN_CORS_ORIGINS || '*')
    .split(',').map(s => s.trim()).filter(Boolean);

async function main() {
    await r2.send(new PutBucketCorsCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        CORSConfiguration: {
            CORSRules: [
                { // ダウンロード（Pages 経由の閲覧）
                    AllowedOrigins: [process.env.PAGES_BASE_URL],
                    AllowedMethods: ['GET', 'HEAD'],
                    AllowedHeaders: ['*'],
                    MaxAgeSeconds: 86400,
                },
                { // 管理画面ブラウザからの直PUT（再送/再合成）。認可は pre-signed 署名で担保。
                    AllowedOrigins: ADMIN_CORS_ORIGINS,
                    AllowedMethods: ['PUT', 'GET', 'HEAD'],
                    AllowedHeaders: ['*'],
                    ExposeHeaders: ['ETag'],
                    MaxAgeSeconds: 86400,
                },
            ],
        },
    }));

    const res = await r2.send(new GetBucketCorsCommand({ Bucket: process.env.R2_BUCKET_NAME }));
    console.log('CORS set:', JSON.stringify(res.CORSRules, null, 2));
}

main().catch(console.error);
