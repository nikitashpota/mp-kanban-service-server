const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const SECRET = process.env.JWT_SECRET || 'mosproekt-secret-2024';

async function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const token = auth.slice(7);
    const payload = jwt.verify(token, SECRET);
    // payload может содержать _id или id в зависимости от версии
    const userId = payload.id || payload._id || payload.userId;
    if (!userId) return res.status(401).json({ error: 'Неверный токен: нет id' });

    const { rows } = await pool.query(
      'SELECT id, username, role, full_name FROM users WHERE id=$1', [userId]
    );
    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = rows[0];
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(401).json({ error: 'Неверный токен: ' + err.message });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Требуются права администратора' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    if (roles.includes(req.user?.role)) return next();
    res.status(403).json({ error: `Требуется роль: ${roles.join(' или ')}` });
  };
}

const requirePM           = requireRole('pm');
const requirePassportEdit = requireRole('pm', 'gip');

module.exports = { authenticate, requireAdmin, requireRole, requirePM, requirePassportEdit };
