const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

const ROLES = ['admin','pm','gip','viewer'];

router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, full_name, role, created_at FROM users ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    console.error('GET users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { username, password, full_name = '', role = 'viewer' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните имя и пароль' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, full_name, role`,
      [username, hash, full_name || '', role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST users error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Пользователь уже существует' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', authenticate, requireAdmin, async (req, res) => {
  const { role, password, full_name } = req.body;
  const sets = []; const vals = [];
  if (role && ROLES.includes(role)) { sets.push(`role=$${vals.length+1}`); vals.push(role); }
  if (full_name !== undefined)       { sets.push(`full_name=$${vals.length+1}`); vals.push(full_name); }
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    sets.push(`password_hash=$${vals.length+1}`); vals.push(hash);
  }
  if (!sets.length) return res.status(400).json({ error: 'Нет данных' });
  vals.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING id, username, full_name, role`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Не найден' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
