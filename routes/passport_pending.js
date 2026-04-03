const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const requirePM  = requireRole('pm');
const requireGIP = requireRole('pm', 'gip');

// GET /api/pending/:projectId
router.get('/:projectId', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ps.id, ps.stage_name, ps.sub_stage_name, ps.stage_num,
             ps.execution_actual_pending, ps.execution_actual_pending_2,
             ps.pending_at, ps.kanban_slot,
             u.username AS pending_by_name, u.id AS pending_by_id
      FROM passport_stages ps
      LEFT JOIN users u ON u.id = ps.pending_by_user_id
      WHERE ps.project_id = $1
        AND (ps.execution_actual_pending IS NOT NULL OR ps.execution_actual_pending_2 IS NOT NULL)
      ORDER BY ps.sort_order
    `, [req.params.projectId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// POST /api/pending/propose/:stageId — ГИП предлагает дату
router.post('/propose/:stageId', authenticate, requireGIP, async (req, res) => {
  const { date, slot } = req.body;
  const n = v => (v === '' || v == null) ? null : v;
  const field = slot === 2 ? 'execution_actual_pending_2' : 'execution_actual_pending';
  try {
    const { rows } = await pool.query(
      `UPDATE passport_stages SET ${field}=$1, pending_by_user_id=$2, pending_at=NOW()
       WHERE id=$3 RETURNING id, stage_name, sub_stage_name, ${field}, pending_at`,
      [n(date), req.user.id, req.params.stageId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Этап не найден' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Ошибка сохранения' }); }
});

// POST /api/pending/approve/:stageId — РП утверждает
router.post('/approve/:stageId', authenticate, requirePM, async (req, res) => {
  const { slot } = req.body;
  const pf = slot === 2 ? 'execution_actual_pending_2' : 'execution_actual_pending';
  const af = slot === 2 ? 'execution_actual_2'         : 'execution_actual';
  try {
    const { rows } = await pool.query(
      `UPDATE passport_stages
       SET ${af}=${pf}, ${pf}=NULL,
           pending_by_user_id = CASE WHEN execution_actual_pending IS NULL AND execution_actual_pending_2 IS NULL THEN NULL ELSE pending_by_user_id END,
           pending_at         = CASE WHEN execution_actual_pending IS NULL AND execution_actual_pending_2 IS NULL THEN NULL ELSE pending_at END
       WHERE id=$1 RETURNING *`,
      [req.params.stageId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Не найдено' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Ошибка утверждения' }); }
});

// POST /api/pending/reject/:stageId — РП отклоняет
router.post('/reject/:stageId', authenticate, requirePM, async (req, res) => {
  const { slot } = req.body;
  const pf = slot === 2 ? 'execution_actual_pending_2' : 'execution_actual_pending';
  try {
    await pool.query(
      `UPDATE passport_stages SET ${pf}=NULL,
           pending_by_user_id = CASE WHEN execution_actual_pending IS NULL AND execution_actual_pending_2 IS NULL THEN NULL ELSE pending_by_user_id END,
           pending_at         = CASE WHEN execution_actual_pending IS NULL AND execution_actual_pending_2 IS NULL THEN NULL ELSE pending_at END
       WHERE id=$1`,
      [req.params.stageId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// GET /api/pending/count/all — для бейджа на дашборде
router.get('/count/all', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id AS project_id, p.name AS project_name,
             COUNT(*) AS pending_count,
             MAX(ps.pending_at) AS latest_pending,
             u.username AS latest_by
      FROM passport_stages ps
      JOIN projects p ON p.id = ps.project_id
      LEFT JOIN users u ON u.id = ps.pending_by_user_id
      WHERE ps.execution_actual_pending IS NOT NULL OR ps.execution_actual_pending_2 IS NOT NULL
      GROUP BY p.id, p.name, u.username
      ORDER BY MAX(ps.pending_at) DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

module.exports = router;
