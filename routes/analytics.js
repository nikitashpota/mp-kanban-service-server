const router = require('express').Router();
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  const { type_id } = req.query;
  const typeFilter = type_id ? ' AND p.project_type_id = $1' : '';
  const typeVal = type_id ? [parseInt(type_id)] : [];

  try {
    // ── Totals ─────────────────────────────────────────────────
    const totalRes = await pool.query(
      `SELECT p.id,
              p.is_terminated
       FROM projects p WHERE p.is_active = true${typeFilter}`,
      typeVal
    );
    const allIds = totalRes.rows.map(r => r.id);
    const terminatedIds = totalRes.rows.filter(r => r.is_terminated).map(r => r.id);

    if (allIds.length === 0) {
      return res.json({
        total: 0, terminated: 0,
        thz: { presented: 0, done: 0, needs_correction: 0, not_provided: 0, in_progress: 0 },
        apr: { total: 0, done: 0, on_approval: 0, in_progress: 0, needs_correction: 0 },
        mge: { in_progress: 0, done: 0, problem: 0 },
        ids: {}
      });
    }

    // ── Stage statuses for all active projects ─────────────────
    const stagesRes = await pool.query(
      `SELECT ps.project_id, ps.stage_num, ps.kanban_status
       FROM passport_stages ps
       WHERE ps.project_id = ANY($1::int[])
         AND ps.stage_num IN ('1','10','22','23')`,
      [allIds]
    );

    // Map: { project_id: { '1': status, '10': status, '22': status, '23': status } }
    const byProject = {};
    stagesRes.rows.forEach(r => {
      if (!byProject[r.project_id]) byProject[r.project_id] = {};
      byProject[r.project_id][r.stage_num] = r.kanban_status;
    });

    // ── Category buckets ───────────────────────────────────────
    const ids = {
      thz_done: [], thz_needs_correction: [], thz_not_provided: [], thz_in_progress: [],
      apr_done: [], apr_on_approval: [], apr_in_progress: [], apr_needs_correction: [],
      mge_in_progress: [], mge_done: [], mge_problem: [],
      terminated: terminatedIds,
    };

    const nonTerminated = allIds.filter(id => !terminatedIds.includes(id));

    nonTerminated.forEach(id => {
      const s = byProject[id] || {};

      // ТхЗ (stage 1)
      const thz = s['1'];
      if (thz === 'done' || thz === 'developed') ids.thz_done.push(id);
      else if (thz === 'needs_correction') ids.thz_needs_correction.push(id);
      else if (thz === 'not_provided') ids.thz_not_provided.push(id);
      else if (thz === 'in_progress') ids.thz_in_progress.push(id);

      // АПР (stage 10)
      const apr = s['10'];
      if (apr === 'done') ids.apr_done.push(id);
      else if (apr === 'developed') ids.apr_on_approval.push(id);
      else if (apr === 'in_progress') ids.apr_in_progress.push(id);
      else if (apr === 'needs_correction') ids.apr_needs_correction.push(id);

      // МГЭ логика:
      // stage 22 = Загрузка МГЭ, stage 23 = Заключение МГЭ
      const mge22 = s['22']; // загрузка
      const mge23 = s['23']; // заключение

      if (mge23 === 'done') {
        // Заключение исполнено → прошли экспертизу
        ids.mge_done.push(id);
      } else if (mge23 === 'not_provided') {
        // Заключение не обеспечено → проблема
        ids.mge_problem.push(id);
      } else if (mge22 === 'done' && mge23 !== 'done') {
        // Загрузка исполнена, заключения нет → в экспертизе
        ids.mge_in_progress.push(id);
      }
    });

    res.json({
      total: allIds.length,
      terminated: terminatedIds.length,
      thz: {
        presented: ids.thz_done.length + ids.thz_needs_correction.length + ids.thz_in_progress.length,
        done: ids.thz_done.length,
        needs_correction: ids.thz_needs_correction.length,
        not_provided: ids.thz_not_provided.length,
        in_progress: ids.thz_in_progress.length,
      },
      apr: {
        total: ids.apr_done.length + ids.apr_on_approval.length + ids.apr_in_progress.length,
        done: ids.apr_done.length,
        on_approval: ids.apr_on_approval.length,
        in_progress: ids.apr_in_progress.length,
        needs_correction: ids.apr_needs_correction.length,
      },
      mge: {
        in_progress: ids.mge_in_progress.length,
        done: ids.mge_done.length,
        problem: ids.mge_problem.length,
      },
      ids, // project IDs per category — used for kanban drill-down
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки аналитики' });
  }
});

module.exports = router;
