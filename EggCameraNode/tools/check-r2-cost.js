// R2 の使用量とコスト見積もり（読み取り専用・S3 API 経由）
// 使い方: node tools/check-r2-cost.js
//
// ソーク監視から定期実行し、コスト増につながる異常を検知する:
//   ・ストレージ肥大（無料枠 10GB への接近）
//   ・24時間保持を超えたオブジェクトの残留（cleanup 不全）
//   ・オブジェクト数の異常増（アップロード暴走の痕跡）
// 操作数(Class A/B)は S3 API からは取れないため、サイクル実績からの目安を併記する。
// 正確な操作数が必要になったら Cloudflare GraphQL Analytics（要 API トークン）を使うこと。
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const {
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
} = require('../src/config');

// R2 料金（2026-06時点）: ストレージ $0.015/GB-月（無料枠10GB）、
// Class A $4.50/100万（無料枠100万/月）、Class B $0.36/100万（無料枠1000万/月）、egress 無料
const FREE_STORAGE_GB = 10;
const PRICE_PER_GB    = 0.015;

(async () => {
    const r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId:     R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });

    let count = 0, bytes = 0, oldest = null, token;
    do {
        const res = await r2.send(new ListObjectsV2Command({
            Bucket: R2_BUCKET,
            ContinuationToken: token,
        }));
        for (const o of res.Contents || []) {
            count++;
            bytes += o.Size;
            if (!oldest || o.LastModified < oldest) oldest = o.LastModified;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    const gb   = bytes / 1e9;
    const ageH = oldest ? (Date.now() - oldest.getTime()) / 3.6e6 : 0;
    const storageCost = Math.max(0, gb - FREE_STORAGE_GB) * PRICE_PER_GB;

    console.log('=== R2 cost check ===');
    console.log(`オブジェクト: ${count}件 / ${(bytes / 1048576).toFixed(1)}MB (${gb.toFixed(2)}GB)`);
    console.log(`最古オブジェクト: ${oldest ? `${oldest.toISOString()} (${ageH.toFixed(1)}時間前)` : 'なし'}`);
    console.log(`ストレージ概算: $${storageCost.toFixed(2)}/月 (無料枠${FREE_STORAGE_GB}GB${gb > FREE_STORAGE_GB ? 'を超過' : '内'})`);
    console.log('操作数の目安: PUT ~900/日 ≒ 2.7万/月 (Class A 無料枠100万/月の3%未満)');

    const warns = [];
    if (gb > FREE_STORAGE_GB * 0.9) warns.push(`▲ ストレージが無料枠に接近/超過: ${gb.toFixed(2)}GB`);
    if (count > 3000) warns.push(`▲ オブジェクト数が異常: ${count}件（24h保持なら~1000件想定）`);
    if (ageH > 26) warns.push(`▲ 24時間保持を超えた残留: 最古${ageH.toFixed(1)}時間前 — cleanup不全の可能性`);

    if (warns.length) {
        console.log('\n--- 要注意 ---');
        for (const w of warns) console.log(w);
        process.exit(1);
    }
    console.log('コスト面の異常なし');
})().catch(err => {
    console.log(`R2_CHECK_FAILED: ${err.message}`);
    process.exit(1);
});
