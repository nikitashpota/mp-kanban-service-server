const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── RESIDENTIAL row-number → stage_num mapping ────────────────
// Key = Excel row number (col A, stringified), Value = stage_num in passport_stages
const RESIDENTIAL_MAP = {
  '1':   { stage_num: '2',      sub: null },            // ГПЗУ
  '2':   { stage_num: '1',      sub: null },            // Техническое задание
  '3':   { stage_num: null,     sub: null, skip: true },// ИИ родительская строка
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

// Sub-row mapping: when col A is empty but col C matches sub_stage_name
// key = sub_stage_name (normalized), value = { stage_num, slot }
const SUB_ROW_MAP = {
  'корректировка':                  { stage_num: 'kvart', slot: null },
  'утверждена в мфр':               { stage_num: 'kvart', slot: 2 },
  'согласованы в мфр':              { stage_num: '10',    slot: 2 },
  'согласовано':                    { stage_num: '15',    slot: 2 },
  'утверждено':                     { stage_num: '18',    slot: 2 },
  'выход мгэ знп':                  { stage_num: '22',    slot: 'exit' },
  'выход мгэ тех':                  { stage_num: '23',    slot: 'exit' },
  'выход мгэ смет':                 { stage_num: '24',    slot: 'exit' },
  'начало выдачи':                  { stage_num: '25',    slot: null },
  'окончание выдачи':               { stage_num: '25',    slot: null },
  'согласование впр':               { stage_num: '25',    slot: null },
};

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && v.match(/\d{4}/)) return v.slice(0, 10);
  return null;
}

function normalizeNum(v) {
  if (v === null || v === undefined) return null;
  return String(v).trim();
}

// POST /api/import/:projectId/xlsx
router.post('/:projectId/xlsx', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  const { projectId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

  try {
    // Check project type
    const typeRes = await pool.query(
      `SELECT pt.kanban_type FROM projects p
       LEFT JOIN project_types pt ON pt.id = p.project_type_id
       WHERE p.id = $1`, [projectId]
    );
    if (!typeRes.rows.length) return res.status(404).json({ error: 'Проект не найден' });
    const kanbanType = typeRes.rows[0].kanban_type || 'administrative';

    if (kanbanType !== 'residential') {
      return res.status(400).json({ error: 'Импорт пока поддерживается только для жилых объектов (реновация/МКД)' });
    }

    // Parse xlsx
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    // Load existing passport stages for this project
    const stagesRes = await pool.query(
      `SELECT id, stage_num, sub_stage_name, kanban_parent_id, kanban_slot
       FROM passport_stages WHERE project_id = $1 ORDER BY sort_order`,
      [projectId]
    );
    if (!stagesRes.rows.length) {
      return res.status(409).json({ error: 'Этапы паспорта не созданы. Сначала нажмите «Создать все этапы» на странице объекта.' });
    }

    // Build lookup: stage_num -> stage row(s)
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

    const updates = []; // { id, fields }
    const log = [];

    let lastMainNum = null;

    for (let ri = 2; ri < rows.length; ri++) { // skip header rows
      const row = rows[ri];
      if (!row || row.every(v => v === null)) continue;

      const colA = normalizeNum(row[0]);
      const colB = row[1] != null ? String(row[1]).trim() : '';
      const colC = row[2] != null ? String(row[2]).trim() : '';
      const colD = row[3] != null ? String(row[3]).trim() : '';
      const colE = row[4]; // Date object or null
      const colF = row[5]; // Date object or null
      const colG = row[6] != null ? String(row[6]).trim() : '';
      const colH = row[7] != null ? String(row[7]).trim() : '';

      const deadline = parseDate(colE);
      const execution = parseDate(colF);
      const readinessRaw = colD || null;
      // readiness in DB is integer (%) — map text values
      let readiness = null;
      if (readinessRaw) {
        const norm = readinessRaw.toLowerCase().trim();
        if (norm === 'получено' || norm === 'выполнено' || norm === 'готово') readiness = 100;
        else if (norm === 'в работе' || norm === 'в процессе') readiness = 50;
        else if (!isNaN(parseInt(norm))) readiness = parseInt(norm);
        // otherwise skip — text values like 'Всего', 'Корректировка' not stored as readiness
      }
      const responsible = colG || null;
      const note = colH || null;

      const fields = {};
      // colE = Срок (договор/директивный) → deadline_contract
      // colF = Исполнение (фактическое)   → execution_actual (канбан читает именно этот)
      if (deadline)    fields.deadline_contract  = deadline;
      if (execution)   fields.execution_actual   = execution;
      if (readiness)   fields.readiness          = readiness;
      if (responsible) fields.responsible        = responsible;
      if (note)        fields.note               = note;

      if (!Object.keys(fields).length) continue;

      // ── Main numbered row ──────────────────────────────────
      if (colA && RESIDENTIAL_MAP[colA]) {
        lastMainNum = colA;
        const mapping = RESIDENTIAL_MAP[colA];
        if (mapping.skip) continue;

        const { stage_num, sub } = mapping;
        if (!stage_num) {
          // sub-rows under 7.x etc — find by sub_stage_name match
          const found = stagesRes.rows.find(s =>
            s.sub_stage_name && colB &&
            s.sub_stage_name.toLowerCase().includes(colB.toLowerCase().slice(0, 15))
          );
          if (found) updates.push({ id: found.id, fields });
          continue;
        }

        // Find the exact stage row
        let target = null;
        if (sub) {
          target = stageByNumAndSub[`${stage_num}::${sub.toLowerCase()}`];
        }
        if (!target && stageByNum[stage_num]) {
          target = stageByNum[stage_num][0];
        }
        if (target) {
          updates.push({ id: target.id, fields });
          log.push(`✓ [${colA}] ${colB} → stage ${stage_num}`);
        }
      }
      // ── Sub-row (col A empty, col C has sub-stage name) ────
      else if (!colA && colC) {
        const subNorm = colC.toLowerCase().trim();

        // Try direct sub_stage_name match in DB
        const dbMatch = stagesRes.rows.find(s =>
          s.sub_stage_name &&
          s.sub_stage_name.toLowerCase().trim().startsWith(subNorm.slice(0, 12))
        );
        if (dbMatch) {
          updates.push({ id: dbMatch.id, fields });
          log.push(`✓ sub [${colC}] → id ${dbMatch.id}`);
        }

        // Special: slot-2 fields on parent (e.g. согласовано → execution_actual_2)
        const slotMapping = Object.entries(SUB_ROW_MAP).find(([k]) => subNorm.startsWith(k));
        if (slotMapping) {
          const { stage_num, slot } = slotMapping[1];
          if (slot === 2 && stageByNum[stage_num]) {
            const parent = stageByNum[stage_num][0];
            if (parent) {
              const slot2Fields = {};
              if (deadline)  slot2Fields.deadline_contract   = deadline;
              if (execution) slot2Fields.execution_actual_2  = execution;
              updates.push({ id: parent.id, fields: slot2Fields });
            }
          }
        }
      }
      // ── Doc rows (Документация) — readiness is in col D ────
      else if (!colA && !colC && colD) {
        // find parent doc stage
        const docStage = stagesRes.rows.find(s =>
          s.sub_stage_name && s.sub_stage_name.toLowerCase().trim() === colD.toLowerCase().trim()
        );
        if (docStage) {
          updates.push({ id: docStage.id, fields: { note: String(colE || '') } });
        }
      }
    }

    // Apply updates
    let updated = 0;
    for (const { id, fields } of updates) {
      const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 1}`);
      const vals = [...Object.values(fields), id];
      if (!sets.length) continue;
      await pool.query(
        `UPDATE passport_stages SET ${sets.join(',')} WHERE id=$${sets.length + 1}`,
        vals
      );
      updated++;
    }

    res.json({ message: `Импорт завершён: обновлено ${updated} строк`, log });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Ошибка импорта: ' + err.message });
  }
});

module.exports = router;