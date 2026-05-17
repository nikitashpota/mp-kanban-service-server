const router = require('express').Router();
const { pool } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'mosproekt-secret-2024';

router.post('/login', async (req, res) => {
  const { username: rawUsername, password } = req.body;
  // Убираем пробелы по краям и приводим к нижнему регистру
  const username = (rawUsername || '').trim().toLowerCase();
  console.log('[LOGIN] attempt:', username);

  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash, role, full_name FROM users WHERE LOWER(username)=$1',
      [username]
    );
    console.log('[LOGIN] user found:', rows.length, rows[0]?.username, rows[0]?.role);

    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    console.log('[LOGIN] password ok:', ok, 'hash prefix:', user.password_hash?.slice(0,7));

    if (!ok) return res.status(401).json({ error: 'Неверный пароль' });

    const role = user.role || 'viewer';
    const token = jwt.sign({ id: user.id, username: user.username, role }, SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name || user.username, role, isAdmin: role === 'admin' }
    });
  } catch (err) {
    console.error('[LOGIN] error:', err.message);
    res.status(500).json({ error: 'Ошибка сервера: ' + err.message });
  }
});

module.exports = router;