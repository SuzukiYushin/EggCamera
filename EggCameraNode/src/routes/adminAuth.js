// 管理APIの共有認証ミドルウェア。ADMIN_TOKEN 設定時のみ要求（未設定なら素通り）。
// ヘッダ X-Admin-Token か ?token= で渡す。core(:3000)/admin(:3001) 両方で使う。
const { ADMIN_TOKEN } = require('../config');

module.exports = function adminAuth(req, res, next) {
    if (!ADMIN_TOKEN) return next();
    const tok = req.get('X-Admin-Token') || req.query.token;
    if (tok === ADMIN_TOKEN) return next();
    res.status(401).json({ error: 'unauthorized' });
};
