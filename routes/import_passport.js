const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ГИП и РП могут импортировать XLSX
const requireEditor = requireRole('pm', 'gip');

// ─── Residential map ──────────────────────────────────────────────────────────
const RESIDENTIAL_MAP = {
  '1':   { stage_num: '2',      sub: null },
  '2':   { stage_num: '1',      sub: null },
  '3':   { stage_num: null,     sub: null, skip: true },
  '3.1': { stage_num: '5',      sub: 'инженерно-геодезические' },
  '3.2': { stage_num: '6',      sub: 'инженерно-геологические' },
  '3.3': { stage_num: null,     sub: null, skip: true }, // гидрологические — нет в БД
  '3.4': { stage_num: '7',      sub: 'инженерно-экологические' },
  '3.5': { stage_num: '9',      sub: 'обследование' },
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

const RESIDENTIAL_SUB_ROW_MAP = {
  'корректировка':     { stage_num: 'kvart', slot: null },
  'утверждена в мфр':  { stage_num: 'kvart', slot: 2 },
  'согласованы в мфр': { stage_num: '10',    slot: 2 },
  'согласовано':       { stage_num: '15',    slot: 2 },
  'утверждено':        { stage_num: '18',    slot: 2 },
  'начало выдачи':     { stage_num: '25',    slot: null },
  'окончание выдачи':  { stage_num: '25',    slot: null },
  'согласование впр':  { stage_num: '25',    slot: null },
};

// ─── Administrative map ───────────────────────────────────────────────────────
// col[0] — целое число (int) для нумерованных строк
//
// Особенности формата административного XLSX:
//  - Excel 7  = гидрометеорологические — нет в ADMIN_STAGES → skip
//  - Excel 8  = экологические → stage_num '7' (нумерация расходится)
//  - Excel 20 = Консультационные услуги — нет в ADMIN_STAGES → skip
//  - Excel 26 → stage_num '28' (Начало СМР)
//  - Excel 27 → stage_num '29' (Ввод в эксплуатацию)
//  - Excel 28/29 = статистика документации → нет в map (пропускаем)
const ADMINISTRATIVE_MAP = {
  1:  { stage_num: '1',  sub: null },
  2:  { stage_num: '2',  sub: null },
  3:  { stage_num: '3',  sub: null },
  4:  { stage_num: '4',  sub: null },
  5:  { stage_num: '5',  sub: 'инженерно-геодезические' },
  6:  { stage_num: '6',  sub: 'инженерно-геологические' },
  7:  { stage_num: null, sub: null, skip: true }, // гидрометеорологические — нет в ADMIN_STAGES
  8:  { stage_num: '7',  sub: 'инженерно-экологические' },
  9:  { stage_num: '9',  sub: 'обследование' },
  10: { stage_num: '10', sub: 'разработка' },
  11: { stage_num: '11', sub: null },
  12: { stage_num: '12', sub: 'разработка' },
  13: { stage_num: '13', sub: null },
  14: { stage_num: '14', sub: null },
  15: { stage_num: '15', sub: 'разработка' },
  16: { stage_num: '16', sub: null },
  17: { stage_num: '17', sub: null },
  18: { stage_num: '18', sub: 'разработка' },
  19: { stage_num: '19', sub: null },
  20: { stage_num: null, sub: null, skip: true }, // Консультационные услуги — нет в ADMIN_STAGES
  21: { stage_num: '21', sub: null },
  22: { stage_num: '22', sub: 'вход' },
  23: { stage_num: '23', sub: 'вход' },
  24: { stage_num: '24', sub: 'вход' },
  25: { stage_num: '25', sub: 'Начало выдачи' },
  26: { stage_num: '28', sub: null }, // Начало СМР
  27: { stage_num: '29', sub: null }, // Ввод в эксплуатацию
};

// Подстроки без номера для slot-2 обновления родителя
const ADMIN_SUB_ROW_MAP = {
  'согласование дгп+мэр': { stage_num: '15', slot: 2 },
  'согласование дгп+мер': { stage_num: '15', slot: 2 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    // XLSX хранит даты без времени (полночь), но JS Date завязан на UTC.
    // При смещении UTC+N toISOString() возвращает предыдущие сутки.
    // Прибавляем 12 часов (полдень) — это гарантирует правильный день
    // при любом реальном смещении часового пояса (±12ч).
    return new Date(v.getTime() + 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  if (typeof v === 'string' && v.match(/\d{4}/)) return v.slice(0, 10);
  return null;
}

// Парсит строку "dd.mm.yyyy" → "yyyy-mm-dd"
function parseRuDate(s) {
  if (!s) return null;
  s = String(s).trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
  return null;
}

// Универсальный парсер последней даты из ячейки.
// Поддерживает разделители: \n, →, /
// Пропускает "не определено", "-", любой нечисловой текст → null.
// Из нескольких дат берёт ПОСЛЕДНЮЮ (актуальную).
function parseLastDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return new Date(v.getTime() + 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const parts = v.split(/[\n→\/]/).map(s => s.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const d = parseRuDate(parts[i]);
      if (d) return d;
    }
  }
  return null;
}

// ─── Router ───────────────────────────────────────────────────────────────────
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

    // ── Жилые объекты ──────────────────────────────────────────────────────────
    if (kanbanType === 'residential') {
      let lastStageNum = null; // для привязки sub-строк (выход и пр.) к родителю

      for (let ri = 2; ri < rows.length; ri++) {
        const row = rows[ri];
        if (!row || row.every(v => v === null)) continue;

        const colA = row[0] != null ? String(row[0]).trim() : null;
        const colC = row[2] != null ? String(row[2]).trim() : '';
        const colE = row[4];
        const colF = row[5];
        const colG = row[6] != null ? String(row[6]).trim() : '';
        const colH = row[7] != null ? String(row[7]).trim() : '';

        // Используем parseLastDate для обеих дат:
        //  - "не определено", "-" → null (автоматически)
        //  - "дата1 → дата2", "дата1\nдата2", "дата1/дата2" → последняя дата
        const deadline  = parseLastDate(colE);
        const execution = parseLastDate(colF);
        const fields    = {};
        if (deadline)  fields.deadline_contract = deadline;
        if (execution) fields.execution_actual  = execution;
        if (colG)      fields.responsible       = colG;
        if (colH)      fields.note              = colH;
        if (!Object.keys(fields).length) continue;

        if (colA && RESIDENTIAL_MAP[colA]) {
          const mapping = RESIDENTIAL_MAP[colA];
          if (mapping.skip) continue;
          const { stage_num, sub } = mapping;
          if (!stage_num) continue;

          lastStageNum = stage_num; // запоминаем для последующих sub-строк

          let target = null;
          if (sub) target = stageByNumAndSub[`${stage_num}::${sub.toLowerCase()}`];
          if (!target && stageByNum[stage_num]) target = stageByNum[stage_num][0];
          if (target) updates.push({ id: target.id, fields });
          else skipped.push(`Не найдено в БД: ${stage_num} / ${sub}`);

        } else if (!colA && colC) {
          const subNorm = colC.toLowerCase().trim();

          // Сначала ищем по lastStageNum + sub_stage_name (точная привязка к родителю)
          let dbMatch = null;
          if (lastStageNum) {
            dbMatch = stagesRes.rows.find(s =>
              s.stage_num === lastStageNum &&
              s.sub_stage_name &&
              s.sub_stage_name.toLowerCase().trim().startsWith(subNorm.slice(0, 14))
            );
          }
          // Если не нашли — fallback: глобальный поиск по sub_stage_name
          if (!dbMatch) {
            dbMatch = stagesRes.rows.find(s =>
              s.sub_stage_name && s.sub_stage_name.toLowerCase().trim().startsWith(subNorm.slice(0, 12))
            );
          }
          if (dbMatch) updates.push({ id: dbMatch.id, fields });

          // Slot-2: специальные подстроки обновляют _2-поля родителя
          const slotEntry = Object.entries(RESIDENTIAL_SUB_ROW_MAP).find(([k]) => subNorm.startsWith(k));
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

    } else {
      // ── Административные объекты ────────────────────────────────────────────
      // Строки 0-8: заголовки и метаданные, данные начинаются с row 9
      for (let ri = 9; ri < rows.length; ri++) {
        const row = rows[ri];
        if (!row || row.every(v => v === null)) continue;

        const colA0 = row[0];

        // Пропускаем строки-заголовки (строки) и статистику
        if (typeof colA0 === 'string') continue;
        // Пропускаем подстроки РСО: col[0] — дата договора, а не номер этапа
        if (colA0 instanceof Date) continue;

        const colC = row[2] != null
          ? String(row[2]).trim().replace(/\n/g, ' ').replace(/\s+/g, ' ')
          : '';
        const colE = row[4];
        const colF = row[5];
        const colG = row[6] != null ? String(row[6]).trim() : '';
        const colH = row[7] != null ? String(row[7]).trim() : '';

        const deadline  = parseDate(colE);
        const execution = parseLastDate(colF);

        const fields = {};
        if (deadline)   fields.deadline_contract  = deadline;
        if (execution)  fields.deadline_directive = execution;
        if (execution)  fields.execution_actual   = execution;
        if (colG)     fields.responsible       = colG;
        if (colH)     fields.note              = colH;
        if (!Object.keys(fields).length) continue;

        if (typeof colA0 === 'number') {
          // Нумерованная строка
          const mapping = ADMINISTRATIVE_MAP[colA0];
          if (!mapping || mapping.skip) {
            skipped.push(`Excel строка ${colA0}: нет соответствия в ADMIN_STAGES`);
            continue;
          }
          const { stage_num, sub } = mapping;
          if (!stage_num) continue;

          let target = null;
          if (sub) target = stageByNumAndSub[`${stage_num}::${sub.toLowerCase()}`];
          if (!target && stageByNum[stage_num]) target = stageByNum[stage_num][0];
          if (target) updates.push({ id: target.id, fields });
          else skipped.push(`Не найдено в БД: stage_num=${stage_num} / sub=${sub}`);

        } else if (colA0 == null && colC) {
          // Подстрока без номера — матчим по sub_stage_name в БД
          const subNorm = colC.toLowerCase().trim();

          const dbMatch = stagesRes.rows.find(s =>
            s.sub_stage_name &&
            s.sub_stage_name.toLowerCase().trim().replace(/\n/g, ' ').startsWith(subNorm.slice(0, 14))
          );
          if (dbMatch) updates.push({ id: dbMatch.id, fields });

          // Slot-2: обновляем _2 поля родителя для специальных подстрок
          const slotEntry = Object.entries(ADMIN_SUB_ROW_MAP).find(([k]) => subNorm.startsWith(k));
          if (slotEntry) {
            const { stage_num, slot } = slotEntry[1];
            if (slot === 2 && stageByNum[stage_num]) {
              const parent = stageByNum[stage_num][0];
              if (parent) {
                const s2 = {};
                if (deadline)   s2.deadline_contract  = deadline;
                if (execution)  s2.execution_actual_2 = execution;
                if (Object.keys(s2).length) updates.push({ id: parent.id, fields: s2 });
              }
            }
          }

          if (!dbMatch && !slotEntry) {
            skipped.push(`Подстрока не найдена в БД: "${colC}"`);
          }
        }
      }
    }

    // ── Применяем обновления ──────────────────────────────────────────────────
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
