const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Columns shown in kanban — mapped to stage_num in passport_stages
// Group → column label → stage_num
const KANBAN_STAGE_NUMS = ['1','2','3','bzu','5','6','7','10','13','14','15','18','trans','shopr','22','23','kvart','snos','rd_zero'];

// GET /api/kanban — all projects with passport summary + kanban stage statuses
router.get('/', authenticate, async (req, res) => {
  try {
    // All active projects with type info and passport
    const projectsRes = await pool.query(`
      SELECT p.*, pt.name AS type_name, pt.color AS type_color,
             pt.is_renovation AS type_is_renovation, pt.kanban_type AS type_kanban_type,
             pp.contract_pir, pp.customer, pp.completion_date as passport_completion
      FROM projects p
      LEFT JOIN project_types pt ON pt.id = p.project_type_id
      LEFT JOIN project_passport pp ON pp.project_id = p.id
      WHERE p.is_active = true
      ORDER BY p.name
    `);

    // All kanban-relevant passport stages for all projects
    const stagesRes = await pool.query(`
      SELECT ps.id, ps.project_id, ps.stage_num, ps.stage_name, ps.sub_stage_name,
             ps.kanban_status, ps.execution_planned, ps.execution_actual, ps.deadline_contract,
             ps.readiness,
             ps.kanban_status_2, ps.execution_planned_2, ps.execution_actual_2
      FROM passport_stages ps
      WHERE ps.stage_num = ANY($1::text[])
    `, [KANBAN_STAGE_NUMS]);

    // Issues count per project (for "problematic" flag)
    const issuesRes = await pool.query(`
      SELECT project_id, COUNT(*) AS issue_count
      FROM passport_issues
      WHERE problem IS NOT NULL AND problem != ''
      GROUP BY project_id
    `);

    const issueMap = {};
    issuesRes.rows.forEach(r => { issueMap[r.project_id] = parseInt(r.issue_count); });

    // Group stages by project_id
    const stagesByProject = {};
    stagesRes.rows.forEach(s => {
      if (!stagesByProject[s.project_id]) stagesByProject[s.project_id] = {};
      stagesByProject[s.project_id][s.stage_num] = s;
    });

    const result = projectsRes.rows.map(p => ({
      ...p,
      stages: stagesByProject[p.id] || {},
      issue_count: issueMap[p.id] || 0,
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки канбана' });
  }
});

// PATCH /api/kanban/stage/:stageId — update kanban_status for one cell
router.patch('/stage/:stageId', authenticate, requireAdmin, async (req, res) => {
  const { kanban_status, execution_planned, kanban_status_2, execution_planned_2 } = req.body;

  const allowed = ['done', 'not_provided', 'needs_correction', 'in_progress', 'not_required', 'developed', null];

  if ('kanban_status' in req.body && !allowed.includes(kanban_status))
    return res.status(400).json({ error: 'Недопустимый статус' });
  if ('kanban_status_2' in req.body && !allowed.includes(kanban_status_2))
    return res.status(400).json({ error: 'Недопустимый статус_2' });

  try {
    const sets = [];
    const vals = [];

    if ('kanban_status' in req.body)   { sets.push(`kanban_status=$${vals.length+1}`);    vals.push(kanban_status); }
    if (execution_planned !== undefined){ sets.push(`execution_planned=$${vals.length+1}`); vals.push(execution_planned || null); }
    if ('kanban_status_2' in req.body)  { sets.push(`kanban_status_2=$${vals.length+1}`);  vals.push(kanban_status_2); }
    if (execution_planned_2 !== undefined){ sets.push(`execution_planned_2=$${vals.length+1}`); vals.push(execution_planned_2 || null); }

    if (!sets.length) return res.status(400).json({ error: 'Нет полей для обновления' });

    vals.push(req.params.stageId);
    const { rows } = await pool.query(
      `UPDATE passport_stages SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

module.exports = router;
