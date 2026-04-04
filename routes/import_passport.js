const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ГИП и РП могут импортировать XLSX
const requireEditor = requireRole('pm', 'gip');

const RESIDENTIAL_MAP = {
  '1':   { stage_num: '2',      sub: null },
  '2':   { stage_num: '1',      sub: null },
  '3':   { stage_num: null,     sub: null, skip: true },
  '3.1': { stage_num: '5',      sub: 'инженерно-геодезические' },
  '3.2': { stage_num: '6',      sub: 'инженерно-геологические' },
  '3.3': { stage_num: '7',      sub: 'инженерно-экологические' },
  '3.4': { stage_num: '9',      sub: 'обследование' },
  '4':   { stage_num: 'kvart',  sub: 'получение' },
  '5':   { stage_num: '10',     sub: 'направлены в МФР' },
  '6':   { stage_num: '13',     sub: null },
  '7':   { stage_num: '14',     sub: null },
  '7.1': { stage_num: null,     sub: 'ПАО "Россети" (электроснабжение)' },
  '7.2': { stage_num: null,     sub: 'АО "Мосводоканал" (водоснабжение)' },
  '7.3': { stage_num: null,     sub: 'АО "Мосводоканал" (водоотведение)' },
  '7.4': { stage_num: null,     sub: 'ГУП "Мосводосток" (водоотведение)' },
  '7.5': { stage_num: null,     sub: 'ПАО "МОЭК" (теплоснабжение)' },
  '7.6': { stage_num: null,     sub: 'ПАО "МГТС"' },
  '8':   { stage_num: '15',     sub: 'загружено' },
  '9':   { stage_num: '18',     sub: 'загружено' },
  '10':  { stage_num: '21',     sub: null },
  '11':  { stage_num: '22',     sub: 'вход' },
  '12':  { stage_num: '23',     sub: 'вход' },
  '13':  { stage_num: '24',     sub: 'вход' },
  '14':  { stage_num: 'rd_zero',sub: 'Выдача нулевого цикла' },
  '15':  { stage_num: '26',     sub: null },
  '16':  { stage_num: '27',     sub: null },
  '17':  { stage_num: 'snos',   sub: null },
  '18':  { stage_num: '28',     sub: null },
  '19':  { stage_num: '29',     sub: null },
};

const SUB_ROW_MAP = {
  'корректировка':     { stage_num: 'kvart', slot: null },
  'утверждена в мфр':  { stage_num: 'kvart', slot: 2 },
  'согласованы в мфр': { stage_num: '10',    slot: 2 },
  'согласовано':       { stage_num: '15',    slot: 2 },
  'утверждено':        { stage_num: '18',    slot: 2 },
  'начало выдачи':     { stage_num: '25',    slot: null },
  'окончание выдачи':  { stage_num: '25',    slot: null },
  'согласование впр':  { stage_num: '25',    slot: null },
};

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && v.match(/\d{4}/)) return v.slice(0, 10);
  return null;
}

// POST /api/import/:projectId/xlsx
router.post('/:projectId/xlsx', authenticate, requireEditor, upload.single('file'), async (req, res) => {
  const { projectId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

  try {
    const typeRes = await pool.query(
      `SELECT pt.kanban_type FROM projects p
       LEFT JOIN project_types pt ON pt.id = p.project_type_id
       WHERE p.id = $1`, [projectId]
    );
    if (!typeRes.rows.length) return res.status(404).json({ error: 'Проект не найден' });
    const kanbanType = typeRes.rows[0].kanban_type || 'administrative';

    if (kanbanType !== 'residential') {
      return res.status(400).json({ error: 'Импорт пока поддерживается только для жилых объектов' });
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    const stagesRes = await pool.query(
      `SELECT id, stage_num, sub_stage_name, kanban_parent_id, kanban_slot
       FROM passport_stages WHERE project_id=$1 ORDER BY sort_order`,
      [projectId]
    );
    if (!stagesRes.rows.length) {
      return res.status(409).json({ error: 'Этапы паспорта не созданы. Нажмите «Создать все этапы» на странице объекта.' });
    }

    const stageByNum = {};
    const stageByNumAndSub = {};
    for (const s of stagesRes.rows) {
      if (s.stage_num) {
        if (!stageByNum[s.stage_num]) stageByNum[s.stage_num] = [];
        stageByNum[s.stage_num].push(s);
        const key = `${s.stage_num}::${(s.sub_stage_name || '').toLowerCase().trim()}`;
        stageByNumAndSub[key] = s;
      }
    }

    const updates = [];
    const skipped = [];

    for (let ri = 2; ri < rows.length; ri++) {
      const row = rows[ri];
      if (!row || row.every(v => v === null)) continue;

      const colA = row[0] != null ? String(row[0]).trim() : null;
      const colC = row[2] != null ? String(row[2]).trim() : '';
      const colE = row[4];
      const colF = row[5];
      const colG = row[6] != null ? String(row[6]).trim() : '';
      const colH = row[7] != null ? String(row[7]).trim() : '';

      const deadline  = parseDate(colE);
      const execution = parseDate(colF);
      const fields    = {};
      if (deadline)  fields.deadline_contract = deadline;
      if (execution) fields.execution_actual  = execution;
      if (colG)      fields.responsible       = colG;
      if (colH)      fields.note              = colH;
      if (!Object.keys(fields).length) continue;

      // Numbered row
      if (colA && RESIDENTIAL_MAP[colA]) {
        const mapping = RESIDENTIAL_MAP[colA];
        if (mapping.skip) continue;
        const { stage_num, sub } = mapping;
        if (!stage_num) continue;

        let target = null;
        if (sub) target = stageByNumAndSub[`${stage_num}::${sub.toLowerCase()}`];
        if (!target && stageByNum[stage_num]) target = stageByNum[stage_num][0];
        if (target) updates.push({ id: target.id, fields });
        else skipped.push(`Не найдено в БД: ${stage_num} / ${sub}`);

      } else if (!colA && colC) {
        // Sub-row by name
        const subNorm = colC.toLowerCase().trim();
        const dbMatch = stagesRes.rows.find(s =>
          s.sub_stage_name && s.sub_stage_name.toLowerCase().trim().startsWith(subNorm.slice(0, 12))
        );
        if (dbMatch) updates.push({ id: dbMatch.id, fields });

        const slotEntry = Object.entries(SUB_ROW_MAP).find(([k]) => subNorm.startsWith(k));
        if (slotEntry) {
          const { stage_num, slot } = slotEntry[1];
          if (slot === 2 && stageByNum[stage_num]) {
            const parent = stageByNum[stage_num][0];
            if (parent) {
              const s2 = {};
              if (deadline)  s2.deadline_contract  = deadline;
              if (execution) s2.execution_actual_2 = execution;
              updates.push({ id: parent.id, fields: s2 });
            }
          }
        }
      }
    }

    let updated = 0;
    for (const { id, fields } of updates) {
      const keys = Object.keys(fields);
      if (!keys.length) continue;
      const sets = keys.map((k, i) => `${k}=$${i + 1}`);
      const vals = [...Object.values(fields), id];
      await pool.query(`UPDATE passport_stages SET ${sets.join(',')} WHERE id=$${keys.length + 1}`, vals);
      updated++;
    }

    res.json({
      message: `Импорт завершён: обновлено ${updated} строк`,
      updated,
      skipped: skipped.length,
      skippedList: skipped,
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Ошибка импорта: ' + err.message });
  }
});

module.exports = router;
