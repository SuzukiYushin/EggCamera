// 管理画面/管理APIの共有認証ミドルウェア。ADMIN_TOKEN/ADMIN_PASSWORD 設定時のみ要求（未設定なら素通り）。
// 認証はいずれかでOK:
//   1) Basic認証（ブラウザのログインダイアログ）: user=ADMIN_USER / pass=ADMIN_PASSWORD
//   2) ヘッダ X-Admin-Token か ?token=（テスト/iPad 用の後方互換。トークンをURLに出さないため、
//      ブラウザ操作は 1) を使う）
// core(:3000)/admin(:3001) 両方で使う。
const { ADMIN_TOKEN, ADMIN_USER, ADMIN_PASSWORD } = require('../config');

const REALM = 'EggCamera Admin';

function challenge(res) {
    res.set('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    res.status(401).json({ error: 'unauthorized' });
}

module.exports = function adminAuth(req, res, next) {
    // どちらの認証材料も無い構成なら従来どおり素通り
    if (!ADMIN_TOKEN && !ADMIN_PASSWORD) return next();

    // 1) 後方互換トークン（テスト/iPad）: X-Admin-Token ヘッダ か ?token=
    const tok = req.get('X-Admin-Token') || req.query.token;
    if (ADMIN_TOKEN && tok === ADMIN_TOKEN) return next();

    // 2) Basic認証（ブラウザ）
    const h = req.get('Authorization') || '';
    if (ADMIN_PASSWORD && h.startsWith('Basic ')) {
        let decoded = '';
        try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { /* ignore */ }
        const i = decoded.indexOf(':');
        const user = i >= 0 ? decoded.slice(0, i) : '';
        const pass = i >= 0 ? decoded.slice(i + 1) : decoded;
        if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
    }

    return challenge(res);
};
