const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// ── GET passport for project ──────────────────────────────────
router.get('/:projectId', authenticate, async (req, res) => {
  const { projectId } = req.params;
  try {
    const header = await pool.query(
      'SELECT * FROM project_passport WHERE project_id=$1', [projectId]
    );
    const stages = await pool.query(
      'SELECT * FROM passport_stages WHERE project_id=$1 ORDER BY sort_order', [projectId]
    );
    const issues = await pool.query(
      'SELECT * FROM passport_issues WHERE project_id=$1 ORDER BY sort_order', [projectId]
    );
    res.json({
      header: header.rows[0] || null,
      stages: stages.rows,
      issues: issues.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки паспорта' });
  }
});

// ── UPSERT passport header ────────────────────────────────────
router.put('/:projectId/header', authenticate, requireAdmin, async (req, res) => {
  const { projectId } = req.params;
  const {
    customer, functional_customer, general_designer,
    developer, aip_cost, completion_date, contract_pir, area_total
  } = req.body;
  const n = v => (v === '' || v == null) ? null : v;
  try {
    const { rows } = await pool.query(
      `INSERT INTO project_passport
         (project_id, customer, functional_customer, general_designer, developer,
          aip_cost, completion_date, contract_pir, area_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (project_id) DO UPDATE SET
         customer=$2, functional_customer=$3, general_designer=$4, developer=$5,
         aip_cost=$6, completion_date=$7, contract_pir=$8, area_total=$9
       RETURNING *`,
      [projectId, n(customer), n(functional_customer), n(general_designer), n(developer),
       n(aip_cost), n(completion_date), n(contract_pir), n(area_total)]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

// ── Bulk save stages (replace all) ───────────────────────────
router.put('/:projectId/stages', authenticate, requireAdmin, async (req, res) => {
  const { projectId } = req.params;
  const { stages } = req.body; // array
  if (!Array.isArray(stages)) return res.status(400).json({ error: 'stages must be array' });

  const n = v => (v === '' || v == null) ? null : v;

  try {
    await pool.query('DELETE FROM passport_stages WHERE project_id=$1', [projectId]);
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      await pool.query(
        `INSERT INTO passport_stages
           (project_id, sort_order, stage_num, stage_name, sub_stage_name,
            readiness, deadline_contract, deadline_directive,
            execution_planned, execution_actual, responsible, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [projectId, i, n(s.stage_num), n(s.stage_name), n(s.sub_stage_name),
         n(s.readiness), n(s.deadline_contract), n(s.deadline_directive),
         n(s.execution_planned), n(s.execution_actual), n(s.responsible), n(s.note)]
      );
    }
    const { rows } = await pool.query(
      'SELECT * FROM passport_stages WHERE project_id=$1 ORDER BY sort_order', [projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сохранения этапов' });
  }
});

// ── Update single stage cell ──────────────────────────────────
router.patch('/:projectId/stages/:stageId', authenticate, requireAdmin, async (req, res) => {
  const { stageId } = req.params;
  const fields = req.body; // { field: value }
  const n = v => (v === '' || v == null) ? null : v;

  const allowed = ['readiness','deadline_contract','deadline_directive',
    'execution_planned','execution_actual','responsible','note',
    'stage_name','sub_stage_name'];

  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k}=$${idx++}`); vals.push(n(v)); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Нет полей для обновления' });
  vals.push(stageId);

  try {
    const { rows } = await pool.query(
      `UPDATE passport_stages SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, vals
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

// ── Issues CRUD ───────────────────────────────────────────────
router.put('/:projectId/issues', authenticate, requireAdmin, async (req, res) => {
  const { projectId } = req.params;
  const { issues } = req.body;
  const n = v => (v === '' || v == null) ? null : v;
  try {
    await pool.query('DELETE FROM passport_issues WHERE project_id=$1', [projectId]);
    for (let i = 0; i < issues.length; i++) {
      const iss = issues[i];
      await pool.query(
        'INSERT INTO passport_issues (project_id, sort_order, problem, solution) VALUES ($1,$2,$3,$4)',
        [projectId, i, n(iss.problem), n(iss.solution)]
      );
    }
    const { rows } = await pool.query(
      'SELECT * FROM passport_issues WHERE project_id=$1 ORDER BY sort_order', [projectId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ── Init default stages for new passport ─────────────────────
router.post('/:projectId/init', authenticate, requireAdmin, async (req, res) => {
  const { projectId } = req.params;

  const DEFAULT_STAGES = [
    { num: '1',  name: 'Техническое задание',              sub: null },
    { num: '2',  name: 'ГПЗУ',                             sub: null },
    { num: 'bzu',name: 'Границы ЗУ',                       sub: null },
    { num: '3',  name: 'Договор аренды земельного участка',sub: null },
    { num: '4',  name: 'Технологическое задание',          sub: null },
    { num: '5',  name: 'ИИ',   sub: 'инженерно-геодезические' },
    { num: '6',  name: null,   sub: 'инженерно-геологические' },
    { num: '7',  name: null,   sub: 'инженерно-экологические' },
    { num: '8',  name: null,   sub: 'инженерно-гидрологические' },
    { num: '9',  name: null,   sub: 'обследование' },
    { num: '10', name: 'АПР',  sub: 'разработка' },
    { num: null, name: null,   sub: 'согласование' },
    { num: '11', name: 'Рассмотрение на Штабе ОПР',        sub: null },
    { num: 'shopr', name: 'ШОПР',                          sub: null },
    { num: 'trans', name: 'Транспортная доступность',      sub: null },
    { num: '12', name: 'Задание на проектирование', sub: 'разработка' },
    { num: null, name: null,   sub: 'согласование' },
    { num: '13', name: 'Выдача нагрузок (для договоров с РСО)', sub: null },
    { num: '14', name: 'Получение договоров ТП (ТУ с РСО)',    sub: null },
    { num: '15', name: 'АФК (пред. АГР)', sub: 'разработка' },
    { num: null, name: null, sub: 'первичное рассмотрение ДГП' },
    { num: null, name: null, sub: 'согласование ДГП+МЭР' },
    { num: '16', name: 'Низкополигональная модель',  sub: null },
    { num: '17', name: 'Высокополигональная модель', sub: null },
    { num: '18', name: 'АГР', sub: 'разработка' },
    { num: null, name: null, sub: 'согласование' },
    { num: '19', name: 'ТИМ-модель', sub: null },
    { num: null, name: 'КУ ТИМ',    sub: 'заход' },
    { num: '20', name: null,         sub: 'выход' },
    { num: '21', name: 'Проектная документация', sub: null },
    { num: '22', name: 'МГЭ (ЗнП на ТЭО)', sub: 'вход' },
    { num: null, name: null, sub: 'выход' },
    { num: '23', name: 'МГЭ (тех. часть)', sub: 'вход' },
    { num: null, name: null, sub: 'выход' },
    { num: '24', name: 'МГЭ (сметы)', sub: 'вход' },
    { num: null, name: null, sub: 'выход' },
    { num: '25', name: 'РД', sub: 'Начало выдачи' },
    { num: null, name: null, sub: 'Окончание выдачи' },
    { num: null, name: null, sub: 'Согласование ВПР' },
    { num: '26', name: 'Документация стадии П', sub: null },
    { num: '27', name: 'Документация стадии Р', sub: null },
    { num: '28', name: 'Начало СМР',             sub: null },
    { num: '29', name: 'Ввод в эксплуатацию',    sub: null },
  ];

  try {
    const existing = await pool.query(
      'SELECT id FROM passport_stages WHERE project_id=$1 LIMIT 1', [projectId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Этапы уже инициализированы' });
    }

    for (let i = 0; i < DEFAULT_STAGES.length; i++) {
      const s = DEFAULT_STAGES[i];
      await pool.query(
        `INSERT INTO passport_stages (project_id, sort_order, stage_num, stage_name, sub_stage_name)
         VALUES ($1,$2,$3,$4,$5)`,
        [projectId, i, s.num, s.name, s.sub]
      );
    }
    // Init 3 empty issues
    for (let i = 0; i < 3; i++) {
      await pool.query(
        'INSERT INTO passport_issues (project_id, sort_order) VALUES ($1,$2)', [projectId, i]
      );
    }
    res.json({ message: 'Паспорт инициализирован' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка инициализации' });
  }
});

module.exports = router;
