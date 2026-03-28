const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// GET all types
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM project_types ORDER BY sort_order, name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// POST create
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { name, color, is_renovation, kanban_type } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO project_types (name, color, is_renovation, kanban_type) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, color || '#6b7280', is_renovation || false, kanban_type || 'administrative']
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Ошибка создания' }); }
});

// PUT update
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  const { name, color, is_renovation, kanban_type } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE project_types SET name=$1, color=$2, is_renovation=$3, kanban_type=$4 WHERE id=$5 RETURNING *',
      [name, color || '#6b7280', is_renovation || false, kanban_type || 'administrative', req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// DELETE
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM project_types WHERE id=$1', [req.params.id]);
    res.json({ message: 'Удалено' });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// PATCH project type on a project
router.patch('/assign/:projectId', authenticate, requireAdmin, async (req, res) => {
  const { project_type_id } = req.body;
  try {
    await pool.query(
      'UPDATE projects SET project_type_id=$1 WHERE id=$2',
      [project_type_id || null, req.params.projectId]
    );
    res.json({ message: 'Тип назначен' });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

module.exports = router;
