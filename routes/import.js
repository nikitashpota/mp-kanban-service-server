const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Excel row → stage_num + sub_stage_name mapping (RESIDENTIAL) ──
// Each entry: [excelNum, excelStage, excelSub] → { stageNum, field, subMatch }
// field: which DB field gets the date from col E (deadline_contract) and col F (execution_actual)

const RESIDENTIAL_MAP = [
  // excelNum → stageNum lookup
  { num: '1',   sub: null,                            stageNum: '2',       subStage: null },  // ГПЗУ (row 1 in excel = stage_num 2 in db)
  { num: '2',   sub: null,                            stageNum: '1',       subStage: null },  // ТхЗ
  { num: '3',   sub: null,                            stageNum: null,      subStage: null },  // ИИ parent — skip
  { num: '3.1', sub: null,                            stageNum: '5',       subStage: 'инженерно-геодезические' },
  { num: '3.2', sub: null,                            stageNum: '6',       subStage: 'инженерно-геологические' },
  { num: '3.3', sub: null,                            stageNum: '7',       subStage: 'инженерно-экологические' },
  { num: '3.4', sub: null,                            stageNum: '9',       subStage: 'обследование' },
  { num: '4',   sub: 'получение',                     stageNum: 'kvart',   subStage: 'получение' },
  { num: null,  sub: 'корректировка',                 stageNum: 'kvart',   subStage: 'корректировка' },
  { num: null,  sub: 'утверждена в МФР',              stageNum: 'kvart',   subStage: 'утверждена в МФР (1 этап АПР)', slot: 2 },
  { num: '5',   sub: 'направлены в МФР',              stageNum: '10',      subStage: 'направлены в МФР' },
  { num: null,  sub: 'согласованы в МФР',             stageNum: '10',      subStage: 'согласованы в МФР', slot: 2 },
  { num: '6',   sub: null,                            stageNum: '13',      subStage: null },
  { num: '7',   sub: null,                            stageNum: '14',      subStage: null },
  { num: '7.1', sub: null,                            stageNum: '14',      subStage: 'ПАО "Россети" (электроснабжение)' },
  { num: '7.2', sub: null,                            stageNum: '14',      subStage: 'АО "Мосводоканал" (водоснабжение)' },
  { num: '7.3', sub: null,                            stageNum: '14',      subStage: 'АО "Мосводоканал" (водоотведение)' },
  { num: '7.4', sub: null,                            stageNum: '14',      subStage: 'ГУП "Мосводосток" (водоотведение)' },
  { num: '7.5', sub: null,                            stageNum: '14',      subStage: 'ПАО "МОЭК" (теплоснабжение)' },
  { num: '7.6', sub: null,                            stageNum: '14',      subStage: 'ПАО "МГТС"' },
  { num: '8',   sub: 'загружено',                     stageNum: '15',      subStage: 'загружено' },
  { num: null,  sub: 'согласовано',                   stageNum: '15',      subStage: 'согласовано', slot: 2 },
  { num: '9',   sub: 'загружено',                     stageNum: '18',      subStage: 'загружено' },
  { num: null,  sub: 'утверждено',                    stageNum: '18',      subStage: 'утверждено', slot: 2 },
  { num: '10',  sub: null,                            stageNum: '21',      subStage: null },
  { num: '11',  sub: 'вход',                          stageNum: '22',      subStage: 'вход' },
  { num: null,  sub: 'выход',                         stageNum: '22',      subStage: 'выход' },
  { num: '12',  sub: 'вход',                          stageNum: '23',      subStage: 'вход' },
  { num: null,  sub: 'выход',                         stageNum: '23',      subStage: 'выход' },
  { num: '13',  sub: 'вход',                          stageNum: '24',      subStage: 'вход' },
  { num: null,  sub: 'выход',                         stageNum: '24',      subStage: 'выход' },
  { num: '14',  sub: 'Выдача нулевого цикла',         stageNum: 'rd_zero', subStage: 'Выдача нулевого цикла' },
  { num: null,  sub: 'Начало выдачи',                 stageNum: '25',      subStage: 'Начало выдачи' },
  { num: null,  sub: 'Окончание выдачи',              stageNum: '25',      subStage: 'Окончание выдачи' },
  { num: null,  sub: 'Согласование ВПР',              stageNum: '25',      subStage: 'Согласование ВПР' },
  { num: '15',  sub: null,                            stageNum: '26',      subStage: null },
  { num: '16',  sub: null,                            stageNum: '27',      subStage: null },
  { num: '17',  sub: null,                            stageNum: 'snos',    subStage: null },
  { num: '18',  sub: null,                            stageNum: '28',      subStage: null },
  { num: '19',  sub: null,                            stageNum: '29',      subStage: null },
];

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'string' && val.match(/\d{4}-\d{2}-\d{2}/)) return val.slice(0, 10);
  return null;
}

function normalize(str) {
  if (!str) return '';
  return String(str).trim().toLowerCase().replace(/\s+/g, ' ');
}

// POST /api/import/:projectId/xlsx
router.post('/:projectId/xlsx', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  const { projectId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

  try {
    // Check project type
    const projRes = await pool.query(
      `SELECT pt.kanban_type FROM projects p
       LEFT JOIN project_types pt ON pt.id = p.project_type_id
       WHERE p.id = $1`, [projectId]
    );
    if (!projRes.rows.length) return res.status(404).json({ error: 'Проект не найден' });
    const kanbanType = projRes.rows[0].kanban_type;
    if (kanbanType !== 'residential') {
      return res.status(400).json({ error: 'Пока поддерживается только импорт для жилых объектов' });
    }

    // Load passport stages from DB
    const stagesRes = await pool.query(
      'SELECT * FROM passport_stages WHERE project_id=$1 ORDER BY sort_order', [projectId]
    );
    if (!stagesRes.rows.length) {
      return res.status(409).json({ error: 'Сначала создайте этапы паспорта (кнопка «Создать этапы»)' });
    }

    // Build DB lookup: key = `${stageNum}::${normalize(subStageName)}`
    const dbMap = {};
    for (const s of stagesRes.rows) {
      const key = `${s.stage_num}::${normalize(s.sub_stage_name)}`;
      dbMap[key] = s;
      // Also by stageNum alone (for rows with no sub)
      if (!dbMap[`${s.stage_num}::__main__`]) {
        dbMap[`${s.stage_num}::__main__`] = s;
      }
    }

    // Parse Excel
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    // Find data start (skip header rows 0,1)
    const dataRows = rows.slice(2); // row index 2 = first real data row

    const updates = [];
    const skipped = [];

    for (const excelRow of dataRows) {
      const [numRaw, stageName, subRaw, readiness, dateContract, dateExec, responsible, note] = excelRow;
      if (!numRaw && !stageName && !subRaw) continue; // empty row

      const numStr = numRaw != null ? String(numRaw).trim() : null;
      const subStr = subRaw != null ? String(subRaw).trim() : null;
      const stageStr = stageName != null ? String(stageName).trim() : null;

      // Find mapping entry
      let mapEntry = null;

      // Try to match by number first
      if (numStr) {
        mapEntry = RESIDENTIAL_MAP.find(m =>
          m.num === numStr && (m.sub == null || normalize(m.sub) === normalize(subStr))
        );
      }
      // If no number, match by sub
      if (!mapEntry && subStr) {
        mapEntry = RESIDENTIAL_MAP.find(m =>
          m.num == null && normalize(m.sub) === normalize(subStr)
        );
      }

      if (!mapEntry || !mapEntry.stageNum) {
        if (numStr || subStr) skipped.push(`${numStr || ''} ${subStr || stageStr || ''}`);
        continue;
      }

      // Find DB row
      const subKey = normalize(mapEntry.subStage);
      let dbRow = dbMap[`${mapEntry.stageNum}::${subKey}`];
      if (!dbRow) dbRow = dbMap[`${mapEntry.stageNum}::__main__`];
      if (!dbRow) {
        skipped.push(`Не найдено в БД: ${mapEntry.stageNum} / ${mapEntry.subStage}`);
        continue;
      }

      // Prepare update fields
      const fields = {};
      const d1 = parseDate(dateContract);
      const d2 = parseDate(dateExec);

      if (mapEntry.slot === 2) {
        // slot-2 row: write to _2 fields of parent
        const parentRow = stagesRes.rows.find(s => s.id === dbRow.kanban_parent_id) || dbRow;
        if (d1) fields['deadline_contract'] = d1; // slot2 uses deadline as plan
        if (d2) { fields['execution_actual_2'] = d2; }
        if (responsible) fields['responsible'] = String(responsible).trim();
        if (note) fields['note'] = String(note).trim();
        updates.push({ id: parentRow.id, fields, isSlot2: true, slot2Id: dbRow.id });
      } else {
        if (d1) fields['deadline_contract'] = d1;
        if (d2) fields['execution_actual'] = d2;
        if (readiness && typeof readiness === 'string' && readiness !== 'Всего' && readiness !== 'Всего комплектов') {
          // Text readiness like "получено"
          fields['note'] = fields['note'] || String(readiness).trim();
        }
        if (typeof readiness === 'number') fields['note'] = String(readiness);
        if (responsible) fields['responsible'] = String(responsible).trim();
        if (note) fields['note'] = String(note).trim();
        updates.push({ id: dbRow.id, fields });
      }
    }

    // Apply updates
    let updated = 0;
    for (const upd of updates) {
      const keys = Object.keys(upd.fields);
      if (!keys.length) continue;
      const sets = keys.map((k, i) => `${k}=$${i + 1}`);
      const vals = keys.map(k => upd.fields[k]);
      vals.push(upd.id);
      await pool.query(
        `UPDATE passport_stages SET ${sets.join(',')} WHERE id=$${vals.length}`,
        vals
      );
      // For slot-2: also update the slot-2 row's execution_actual for display
      if (upd.isSlot2 && upd.fields.execution_actual_2) {
        await pool.query(
          'UPDATE passport_stages SET execution_actual=$1 WHERE id=$2',
          [upd.fields.execution_actual_2, upd.slot2Id]
        );
      }
      updated++;
    }

    res.json({
      message: `Импорт завершён: обновлено ${updated} строк`,
      updated,
      skipped: skipped.length,
      skippedList: skipped
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Ошибка импорта: ' + err.message });
  }
});

module.exports = router;
