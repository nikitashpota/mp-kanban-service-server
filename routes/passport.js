const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin, requireRole, requirePassportEdit } = require('../middleware/auth');

// ГИП и РП могут создавать/редактировать паспорт
const requireEditor = requireRole('pm', 'gip');

// ── GET passport for project ──────────────────────────────────
router.get('/:projectId', authenticate, async (req, res) => {
  const { projectId } = req.params;
  try {
    const header = await pool.query(
      'SELECT * FROM project_passport WHERE project_id=$1', [projectId]
    );
    const stages = await pool.query(
      `SELECT ps.*, pp.execution_planned_2 AS parent_planned_2, pp.execution_actual_2 AS parent_actual_2,
              pp.kanban_status_2 AS parent_kanban_status_2,
              u.full_name AS pending_by_name
       FROM passport_stages ps
       LEFT JOIN passport_stages pp ON pp.id = ps.kanban_parent_id
       LEFT JOIN users u ON u.id = ps.pending_by_user_id
       WHERE ps.project_id=$1 ORDER BY ps.sort_order`,
      [projectId]
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

// ── UPSERT passport header (PM + GIP + admin) ─────────────────
router.put('/:projectId/header', authenticate, requireEditor, async (req, res) => {
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

// ── Bulk replace stages — только admin (деструктивно) ─────────
router.put('/:projectId/stages', authenticate, requireAdmin, async (req, res) => {
  const { projectId } = req.params;
  const { stages } = req.body;
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

// ── Update single stage cell (PM + GIP + admin) ───────────────
router.patch('/:projectId/stages/:stageId', authenticate, requirePassportEdit, async (req, res) => {
  const { stageId } = req.params;
  const fields = req.body;
  const n = v => (v === '' || v == null) ? null : v;

  const allowed = ['readiness','deadline_contract','deadline_directive',
    'execution_planned','execution_actual','execution_planned_2','execution_actual_2',
    'responsible','note','stage_name','sub_stage_name','kanban_status','kanban_status_2'];

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
    const updated = rows[0];

    // Sync slot-2 → parent
    if (updated.kanban_slot === 2 && updated.kanban_parent_id) {
      const syncSets = [];
      const syncVals = [];
      let si = 1;
      if ('execution_planned' in fields) { syncSets.push(`execution_planned_2=$${si++}`); syncVals.push(n(fields.execution_planned)); }
      if ('execution_actual' in fields)  { syncSets.push(`execution_actual_2=$${si++}`);  syncVals.push(n(fields.execution_actual)); }
      if ('kanban_status' in fields)     { syncSets.push(`kanban_status_2=$${si++}`);      syncVals.push(n(fields.kanban_status)); }
      if (syncSets.length) {
        syncVals.push(updated.kanban_parent_id);
        await pool.query(`UPDATE passport_stages SET ${syncSets.join(',')} WHERE id=$${si}`, syncVals);
      }
    }

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

// ── Issues save ───────────────────────────────────────────────
router.put('/:projectId/issues', authenticate, requirePassportEdit, async (req, res) => {
  const { projectId } = req.params;
  const { issues } = req.body;
  if (!Array.isArray(issues)) return res.status(400).json({ error: 'issues must be array' });
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
    console.error(err);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

// ── Init endpoint (PM + GIP + admin) ─────────────────────────
router.post('/:projectId/init', authenticate, requireEditor, async (req, res) => {
  // Forward to init-v2
  res.redirect(307, `/api/passport/${req.params.projectId}/init-v2`);
});

// ── Stage templates ───────────────────────────────────────────
const ADMIN_STAGES = [
  { num: '1',     name: 'Техническое задание',                     sub: null,                                 slot: 1 },
  { num: '2',     name: 'ГПЗУ',                                    sub: null,                                 slot: 1 },
  { num: '3',     name: 'Договор аренды земельного участка',       sub: null,                                 slot: 1 },
  { num: '4',     name: 'Технологическое задание',                 sub: null },
  { num: '5',     name: 'ИИ',                                      sub: 'инженерно-геодезические',            slot: 1 },
  { num: '6',     name: null,                                      sub: 'инженерно-геологические',            slot: 1 },
  { num: '7',     name: null,                                      sub: 'инженерно-экологические',            slot: 1 },
  { num: '8',     name: null,                                      sub: 'инженерно-гидрологические' },
  { num: '9',     name: null,                                      sub: 'обследование' },
  { num: '10',    name: 'АПР',                                     sub: 'разработка',                         slot: 1 },
  { num: null,    name: null,                                      sub: 'согласование',                       slot: 2, parentNum: '10' },
  { num: '11',    name: 'Рассмотрение на Штабе ОПР',              sub: null },
  { num: 'shopr', name: 'ШОПР',                                   sub: null,                                 slot: 1 },
  { num: 'trans', name: 'Транспортная доступность',               sub: null,                                 slot: 1 },
  { num: 'bzu',   name: 'Границы ЗУ',                             sub: null,                                 slot: 1 },
  { num: '12',    name: 'Задание на проектирование',              sub: 'разработка' },
  { num: null,    name: null,                                      sub: 'согласование' },
  { num: '13',    name: 'Выдача нагрузок (для договоров с РСО)', sub: null },
  { num: '14',    name: 'Получение договоров ТП (ТУ с РСО)',      sub: null },
  { num: '15',    name: 'АФК (пред. АГР)',                        sub: 'разработка' },
  { num: null,    name: null,                                      sub: 'первичное рассмотрение ДГП',         slot: 1, selfNum: '15' },
  { num: null,    name: null,                                      sub: 'согласование ДГП+МЭР',               slot: 2, parentNum: '15' },
  { num: '16',    name: 'Низкополигональная модель',              sub: null },
  { num: '17',    name: 'Высокополигональная модель',             sub: null },
  { num: '18',    name: 'АГР',                                    sub: 'разработка',                         slot: 1 },
  { num: null,    name: null,                                      sub: 'согласование',                       slot: 2, parentNum: '18' },
  { num: '19',    name: 'ТИМ-модель',                             sub: null },
  { num: '21',    name: 'Проектная документация',                 sub: null },
  { num: '22',    name: 'МГЭ (ЗнП на ТЭО)',                      sub: 'вход',                                slot: 1 },
  { num: null,    name: null,                                      sub: 'выход' },
  { num: '23',    name: 'МГЭ (тех.часть)',                        sub: 'вход',                                slot: 1 },
  { num: null,    name: null,                                      sub: 'выход' },
  { num: '24',    name: 'МГЭ (сметы)',                            sub: 'вход' },
  { num: null,    name: null,                                      sub: 'выход' },
  { num: '25',    name: 'РД',                                     sub: 'Начало выдачи' },
  { num: null,    name: null,                                      sub: 'Окончание выдачи' },
  { num: null,    name: null,                                      sub: 'Согласование ВПР' },
  { num: '26',    name: 'Документация стадии П',                  sub: null },
  { num: null,    name: null,                                      sub: 'Корректировка' },
  { num: null,    name: null,                                      sub: 'На проверке' },
  { num: null,    name: null,                                      sub: 'В разработке' },
  { num: null,    name: null,                                      sub: 'Приняты' },
  { num: '27',    name: 'Документация стадии Р',                  sub: null },
  { num: null,    name: null,                                      sub: 'Выдано в работу' },
  { num: '28',    name: 'Начало СМР',                             sub: null },
  { num: '29',    name: 'Ввод в эксплуатацию',                   sub: null },
];

const RESIDENTIAL_STAGES = [
  { num: '2',       name: 'ГПЗУ',                                          sub: null,                                            slot: 1 },
  { num: '1',       name: 'Техническое задание',                           sub: null,                                            slot: 1 },
  { num: '5',       name: 'Инженерные изыскания и обследование',           sub: 'инженерно-геодезические',                       slot: 1 },
  { num: '6',       name: null,                                            sub: 'инженерно-геологические',                       slot: 1 },
  { num: '7',       name: null,                                            sub: 'инженерно-экологические',                       slot: 1 },
  { num: '9',       name: null,                                            sub: 'обследование' },
  { num: 'kvart',   name: 'Квартирография',                               sub: 'получение',                                     slot: 1 },
  { num: null,      name: null,                                            sub: 'корректировка' },
  { num: null,      name: null,                                            sub: 'утверждена в МФР (1 этап АПР)',                  slot: 2, parentNum: 'kvart' },
  { num: '10',      name: 'АПР',                                          sub: 'направлены в МФР',                               slot: 1 },
  { num: null,      name: null,                                            sub: 'согласованы в МФР',                             slot: 2, parentNum: '10' },
  { num: '13',      name: 'Выдача нагрузок (для договоров с РСО)',        sub: null,                                            slot: 1 },
  { num: '14',      name: 'Получение договоров ТП (ТУ с РСО)',            sub: null,                                            slot: 1 },
  { num: null,      name: null,                                            sub: 'ПАО "Россети" (электроснабжение)' },
  { num: null,      name: null,                                            sub: 'АО "Мосводоканал" (водоснабжение)' },
  { num: null,      name: null,                                            sub: 'АО "Мосводоканал" (водоотведение)' },
  { num: null,      name: null,                                            sub: 'ГУП "Мосводосток" (водоотведение)' },
  { num: null,      name: null,                                            sub: 'ПАО "МОЭК" (теплоснабжение)' },
  { num: null,      name: null,                                            sub: 'ПАО "МГТС" (сети связи)' },
  { num: '15',      name: 'Пред АГР',                                     sub: 'загружено',                                     slot: 1 },
  { num: null,      name: null,                                            sub: 'согласовано',                                   slot: 2, parentNum: '15' },
  { num: '18',      name: 'АГР',                                          sub: 'загружено',                                     slot: 1 },
  { num: null,      name: null,                                            sub: 'утверждено',                                    slot: 2, parentNum: '18' },
  { num: '21',      name: 'Проектная документация',                       sub: null },
  { num: '22',      name: 'МГЭ (ЗнП на ТЭО)',                            sub: 'вход',                                           slot: 1 },
  { num: null,      name: null,                                            sub: 'выход' },
  { num: '23',      name: 'МГЭ (тех. часть)',                             sub: 'вход',                                           slot: 1 },
  { num: null,      name: null,                                            sub: 'выход' },
  { num: '24',      name: 'МГЭ (сметы подготовительный период)',          sub: 'вход' },
  { num: null,      name: null,                                            sub: 'выход' },
  { num: '25',      name: 'РД',                                           sub: 'Начало выдачи' },
  { num: 'rd_zero', name: null,                                           sub: 'Выдача нулевого цикла',                          slot: 1 },
  { num: null,      name: null,                                           sub: 'Окончание выдачи' },
  { num: null,      name: null,                                           sub: 'Согласование ВПР' },
  { num: '26',      name: 'Документация стадии П',                       sub: null },
  { num: null,      name: null,                                           sub: 'Корректировка' },
  { num: null,      name: null,                                           sub: 'На проверке' },
  { num: null,      name: null,                                           sub: 'В разработке' },
  { num: null,      name: null,                                           sub: 'Приняты' },
  { num: '27',      name: 'Документация стадии Р',                       sub: null },
  { num: null,      name: null,                                           sub: 'Выдано в работу' },
  { num: 'snos',    name: 'Снос существующих зданий',                    sub: null,                                             slot: 1 },
  { num: '28',      name: 'Начало СМР',                                  sub: null },
  { num: '29',      name: 'Ввод в эксплуатацию',                         sub: null },
];

// POST /passport/:projectId/init-v2 (PM + GIP + admin)
router.post('/:projectId/init-v2', authenticate, requireEditor, async (req, res) => {
  const { projectId } = req.params;
  try {
    const existing = await pool.query(
      'SELECT id FROM passport_stages WHERE project_id=$1 LIMIT 1', [projectId]
    );
    if (existing.rows.length > 0) {
      const namedStages = await pool.query(
        'SELECT id FROM passport_stages WHERE project_id=$1 AND stage_name IS NOT NULL LIMIT 1',
        [projectId]
      );
      if (namedStages.rows.length > 0) {
        await pool.query('DELETE FROM passport_stages WHERE project_id=$1', [projectId]);
        await pool.query('DELETE FROM passport_issues WHERE project_id=$1', [projectId]);
      } else {
        await pool.query('DELETE FROM passport_stages WHERE project_id=$1 AND stage_name IS NULL', [projectId]);
      }
    }

    const typeRes = await pool.query(
      `SELECT pt.kanban_type FROM projects p
       LEFT JOIN project_types pt ON pt.id = p.project_type_id
       WHERE p.id=$1`, [projectId]
    );
    const isResidential = typeRes.rows[0]?.kanban_type === 'residential';
    const stages = isResidential ? RESIDENTIAL_STAGES : ADMIN_STAGES;

    const insertedIds = {};

    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const { rows } = await pool.query(
        `INSERT INTO passport_stages
          (project_id, sort_order, stage_num, stage_name, sub_stage_name, kanban_slot)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [projectId, i, s.num, s.name, s.sub, s.slot || null]
      );
      const newId = rows[0].id;
      const trackKey = s.slot === 1 ? (s.num || s.selfNum) : null;
      if (trackKey) insertedIds[trackKey] = newId;
      if (s.slot === 2 && s.parentNum && insertedIds[s.parentNum]) {
        await pool.query(
          'UPDATE passport_stages SET kanban_parent_id=$1 WHERE id=$2',
          [insertedIds[s.parentNum], newId]
        );
      }
    }

    for (let i = 0; i < 3; i++) {
      await pool.query(
        'INSERT INTO passport_issues (project_id, sort_order) VALUES ($1,$2)', [projectId, i]
      );
    }

    res.json({
      message: isResidential ? 'Жилой паспорт создан' : 'Административный паспорт создан',
      type: isResidential ? 'residential' : 'administrative'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка инициализации' });
  }
});

module.exports = router;
