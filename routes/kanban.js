const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin, requirePassportEdit } = require('../middleware/auth');

const KANBAN_STAGE_NUMS = ['1','2','3','4','bzu','5','6','7','10','13','14','15','18','trans','shopr','22','23','kvart','snos','rd_zero'];

// GET /api/kanban
router.get('/', authenticate, async (req, res) => {
  try {
    const projectsRes = await pool.query(`
      SELECT p.*, pt.name AS type_name, pt.color AS type_color,
             pt.is_renovation AS type_is_renovation, pt.kanban_type AS type_kanban_type,
             pp.contract_pir, pp.customer, pp.completion_date as passport_completion,
             (SELECT COUNT(*) FROM passport_issues pi
              WHERE pi.project_id = p.id AND pi.problem IS NOT NULL AND pi.problem != '') AS issue_count,
             (SELECT array_agg(pi.problem ORDER BY pi.sort_order)
              FROM (SELECT problem, sort_order FROM passport_issues
                    WHERE project_id = p.id AND problem IS NOT NULL AND problem != ''
                    ORDER BY sort_order LIMIT 3) pi) AS issues_preview
      FROM projects p
      LEFT JOIN project_types pt ON pt.id = p.project_type_id
      LEFT JOIN project_passport pp ON pp.project_id = p.id
      WHERE p.is_active = true
      ORDER BY p.name
    `);

    // Fetch stages including pending fields + pending user name
    const stagesRes = await pool.query(`
      SELECT ps.id, ps.project_id, ps.stage_num, ps.stage_name, ps.sub_stage_name,
             ps.kanban_status, ps.execution_planned, ps.execution_actual,
             ps.deadline_contract, ps.deadline_directive,
             ps.readiness, ps.kanban_slot, ps.kanban_parent_id,
             ps.kanban_status_2, ps.execution_planned_2, ps.execution_actual_2,
             ps.execution_actual_pending, ps.execution_actual_pending_2,
             ps.pending_at,
             u.full_name AS pending_by_name, u.id AS pending_by_id
      FROM passport_stages ps
      LEFT JOIN users u ON u.id = ps.pending_by_user_id
      WHERE ps.stage_num = ANY($1::text[])
         OR (ps.sub_stage_name = 'выход' AND ps.kanban_parent_id IN (
               SELECT id FROM passport_stages WHERE stage_num = '23'
             ))
    `, [KANBAN_STAGE_NUMS]);

    const issuesRes = await pool.query(`
      SELECT project_id, COUNT(*) AS issue_count
      FROM passport_issues
      WHERE problem IS NOT NULL AND problem != ''
      GROUP BY project_id
    `);

    const issueMap = {};
    issuesRes.rows.forEach(r => { issueMap[r.project_id] = parseInt(r.issue_count); });

    const stagesByProject = {};
    stagesRes.rows.forEach(s => {
      if (!stagesByProject[s.project_id]) stagesByProject[s.project_id] = {};
      if (s.stage_num) {
        stagesByProject[s.project_id][s.stage_num] = s;
      } else if (s.sub_stage_name === 'выход' && s.kanban_parent_id) {
        stagesByProject[s.project_id]['23_exit'] = s;
      }
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

// PATCH /api/kanban/stage/:stageId
router.patch('/stage/:stageId', authenticate, requirePassportEdit, async (req, res) => {
  const { kanban_status, execution_planned, execution_actual, kanban_status_2,
          execution_planned_2, execution_actual_2, deadline_directive } = req.body;

  const allowed = ['done', 'not_provided', 'needs_correction', 'in_progress', 'not_required', 'developed', null];
  if ('kanban_status' in req.body && !allowed.includes(kanban_status))
    return res.status(400).json({ error: 'Недопустимый статус' });
  if ('kanban_status_2' in req.body && !allowed.includes(kanban_status_2))
    return res.status(400).json({ error: 'Недопустимый статус_2' });

  const stageId = req.params.stageId;
  if (!stageId || stageId === 'new')
    return res.status(409).json({ error: 'Сначала создайте этапы паспорта на странице объекта' });

  try {
    const sets = [];
    const vals = [];

    if ('kanban_status' in req.body)      { sets.push(`kanban_status=$${vals.length+1}`);      vals.push(kanban_status); }
    if (deadline_directive !== undefined)  { sets.push(`deadline_directive=$${vals.length+1}`);  vals.push(deadline_directive || null); }
    if (execution_planned !== undefined)   { sets.push(`execution_planned=$${vals.length+1}`);   vals.push(execution_planned || null); }
    if ('kanban_status_2' in req.body)    { sets.push(`kanban_status_2=$${vals.length+1}`);     vals.push(kanban_status_2); }
    if (execution_planned_2 !== undefined) { sets.push(`execution_planned_2=$${vals.length+1}`); vals.push(execution_planned_2 || null); }
    if (execution_actual_2 !== undefined)  {
      sets.push(`execution_actual_2=$${vals.length+1}`);
      vals.push(execution_actual_2 || null);
      // Clear pending_2 when PM sets actual_2 directly
      sets.push(`execution_actual_pending_2=NULL`);
    }
    // When PM sets execution_actual directly in kanban — clear pending
    if (execution_actual !== undefined) {
      sets.push(`execution_actual=$${vals.length+1}`);
      vals.push(execution_actual || null);
      sets.push(`execution_actual_pending=NULL`);
      // Clear pending_by / pending_at if both pending are now null
      sets.push(`pending_by_user_id=CASE WHEN execution_actual_pending_2 IS NULL THEN NULL ELSE pending_by_user_id END`);
      sets.push(`pending_at=CASE WHEN execution_actual_pending_2 IS NULL THEN NULL ELSE pending_at END`);
    }

    if (!sets.length) return res.json({ id: stageId });

    vals.push(stageId);
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
