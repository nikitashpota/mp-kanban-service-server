const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// --- Multer config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
    cb(null, name);
  }
});

const uploadPhoto = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

const uploadXlsx = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /xlsx|xls/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

// ============================================================
// GET /api/projects  — список всех проектов (карточки)
// ============================================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.name, p.address, p.stage,
             p.area_total, p.area_building, p.area_underground,
             p.floors_above, p.floors_below, p.height,
             p.completion_date, p.main_photo, p.description,
             p.gip_name, p.is_active, p.created_at, p.project_type_id,
             pt.name AS type_name, pt.color AS type_color,
             (SELECT COUNT(*) FROM passport_issues pi WHERE pi.project_id = p.id AND pi.problem IS NOT NULL AND pi.problem != '') AS notes_count
      FROM projects p
      LEFT JOIN project_types pt ON pt.id = p.project_type_id
      WHERE p.is_active = true
      ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения проектов' });
  }
});

// ============================================================
// GET /api/projects/:id  — детальная страница проекта
// ============================================================
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const projectRes = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    if (!projectRes.rows[0]) return res.status(404).json({ error: 'Проект не найден' });

    const photosRes = await pool.query(
      'SELECT * FROM project_photos WHERE project_id = $1 ORDER BY sort_order, id',
      [id]
    );
    const contactsRes = await pool.query(
      'SELECT * FROM project_contacts WHERE project_id = $1 ORDER BY sort_order, id',
      [id]
    );
    const tepRes = await pool.query(
      'SELECT * FROM project_tep WHERE project_id = $1 ORDER BY sort_order, id',
      [id]
    );
    const networksRes = await pool.query(
      'SELECT * FROM engineering_networks WHERE project_id = $1 ORDER BY sort_order, id',
      [id]
    );
    const passportRes = await pool.query(
      'SELECT * FROM project_passport WHERE project_id = $1',
      [id]
    );
    const passportStagesRes = await pool.query(
      'SELECT * FROM passport_stages WHERE project_id = $1 ORDER BY sort_order',
      [id]
    );
    const passportIssuesRes = await pool.query(
      'SELECT * FROM passport_issues WHERE project_id = $1 ORDER BY sort_order',
      [id]
    );

    res.json({
      project: projectRes.rows[0],
      photos: photosRes.rows,
      contacts: contactsRes.rows,
      tep: tepRes.rows,
      networks: networksRes.rows,
      passport: passportRes.rows[0] || null,
      passportStages: passportStagesRes.rows,
      passportIssues: passportIssuesRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения проекта' });
  }
});

// ============================================================
// POST /api/projects  — создать проект
// ============================================================
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const {
    name, address, inn, kpp, stage,
    area_total, area_building, area_underground,
    floors_above, floors_below, height,
    completion_date, description, gip_name, gip_phone
  } = req.body;

  if (!name) return res.status(400).json({ error: 'Название обязательно' });

  const n = v => (v === '' || v == null) ? null : v;

  try {
    const { rows } = await pool.query(
      `INSERT INTO projects
         (name, address, inn, kpp, stage, area_total, area_building, area_underground,
          floors_above, floors_below, height, completion_date, description, gip_name, gip_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [name, n(address), n(inn), n(kpp), n(stage), n(area_total), n(area_building), n(area_underground),
       n(floors_above), n(floors_below), n(height), n(completion_date), n(description), n(gip_name), n(gip_phone)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка создания проекта' });
  }
});

// ============================================================
// PUT /api/projects/:id  — обновить проект
// ============================================================
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    name, address, inn, kpp, stage,
    area_total, area_building, area_underground,
    floors_above, floors_below, height,
    completion_date, description, gip_name, gip_phone, is_active, is_terminated
  } = req.body;

  const n = v => (v === '' || v == null) ? null : v;

  try {
    const { rows } = await pool.query(
      `UPDATE projects SET
         name=$1, address=$2, inn=$3, kpp=$4, stage=$5,
         area_total=$6, area_building=$7, area_underground=$8,
         floors_above=$9, floors_below=$10, height=$11,
         completion_date=$12, description=$13, gip_name=$14,
         gip_phone=$15, is_active=$16, is_terminated=$17
       WHERE id=$18 RETURNING *`,
      [name, n(address), n(inn), n(kpp), n(stage), n(area_total), n(area_building), n(area_underground),
       n(floors_above), n(floors_below), n(height), n(completion_date), n(description), n(gip_name),
       n(gip_phone), is_active ?? true, is_terminated ?? false, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Проект не найден' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обновления проекта' });
  }
});

// ============================================================
// DELETE /api/projects/:id
// ============================================================
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE projects SET is_active = false WHERE id = $1', [id]);
    res.json({ message: 'Проект удалён' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ============================================================
// POST /api/projects/:id/photos  — загрузить фото
// ============================================================
router.post('/:id/photos', authenticate, requireAdmin,
  uploadPhoto.array('photos', 20), async (req, res) => {
    const { id } = req.params;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Нет файлов' });
    }

    try {
      const inserted = [];
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const { rows } = await pool.query(
          'INSERT INTO project_photos (project_id, filename, sort_order) VALUES ($1,$2,$3) RETURNING *',
          [id, file.filename, i]
        );
        inserted.push(rows[0]);
      }

      // Если нет главного фото — поставить первое
      const proj = await pool.query('SELECT main_photo FROM projects WHERE id=$1', [id]);
      if (!proj.rows[0]?.main_photo) {
        await pool.query('UPDATE projects SET main_photo=$1 WHERE id=$2', [req.files[0].filename, id]);
      }

      res.json(inserted);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка загрузки фото' });
    }
  }
);

// PUT /api/projects/:id/main-photo/:photoId
router.put('/:id/main-photo/:photoId', authenticate, requireAdmin, async (req, res) => {
  const { id, photoId } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT filename FROM project_photos WHERE id=$1 AND project_id=$2', [photoId, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Фото не найдено' });
    await pool.query('UPDATE projects SET main_photo=$1 WHERE id=$2', [rows[0].filename, id]);
    res.json({ message: 'Главное фото обновлено' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// DELETE /api/projects/:id/photos/:photoId
router.delete('/:id/photos/:photoId', authenticate, requireAdmin, async (req, res) => {
  const { id, photoId } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT filename FROM project_photos WHERE id=$1 AND project_id=$2', [photoId, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Фото не найдено' });

    const filepath = path.join(__dirname, '../uploads', rows[0].filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

    await pool.query('DELETE FROM project_photos WHERE id=$1', [photoId]);
    res.json({ message: 'Фото удалено' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления фото' });
  }
});

// ============================================================
// POST /api/projects/:id/tep/upload  — импорт ТЭП из XLSX
// ============================================================
router.post('/:id/tep/upload', authenticate, requireAdmin,
  uploadXlsx.single('file'), async (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });

    try {
      const filepath = path.join(__dirname, '../uploads', req.file.filename);
      const workbook = XLSX.readFile(filepath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // Ожидаемый формат: [Наименование, Значение, Ед.измерения]
      // Первая строка — заголовок, пропускаем
      const rows = data.slice(1).filter(r => r[0] && String(r[0]).trim());

      // Очистить старые ТЭП
      await pool.query('DELETE FROM project_tep WHERE project_id = $1', [id]);

      for (let i = 0; i < rows.length; i++) {
        const [name, value, unit] = rows[i];
        await pool.query(
          'INSERT INTO project_tep (project_id, parameter_name, value, unit, sort_order) VALUES ($1,$2,$3,$4,$5)',
          [id, String(name).trim(), String(value ?? '').trim(), String(unit ?? '').trim(), i]
        );
      }

      // Удалить xlsx после обработки
      fs.unlinkSync(filepath);

      const { rows: tep } = await pool.query(
        'SELECT * FROM project_tep WHERE project_id=$1 ORDER BY sort_order', [id]
      );
      res.json({ message: `Импортировано ${tep.length} строк ТЭП`, tep });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка импорта XLSX: ' + err.message });
    }
  }
);

// ============================================================
// Contacts CRUD
// ============================================================
router.post('/:id/contacts', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { legal_entity, position, person_name, email, sort_order } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO project_contacts (project_id, legal_entity, position, person_name, email, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, legal_entity, position, person_name, email, sort_order ?? 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления контакта' });
  }
});

router.put('/:id/contacts/:contactId', authenticate, requireAdmin, async (req, res) => {
  const { contactId } = req.params;
  const { legal_entity, position, person_name, email } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE project_contacts SET legal_entity=$1, position=$2, person_name=$3, email=$4
       WHERE id=$5 RETURNING *`,
      [legal_entity, position, person_name, email, contactId]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

router.delete('/:id/contacts/:contactId', authenticate, requireAdmin, async (req, res) => {
  const { contactId } = req.params;
  try {
    await pool.query('DELETE FROM project_contacts WHERE id=$1', [contactId]);
    res.json({ message: 'Удалено' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ============================================================
// Stages CRUD
// ============================================================

// PUT /api/projects/:id/photos/:photoId/type
router.put('/:id/photos/:photoId/type', authenticate, requireAdmin, async (req, res) => {
  const { id, photoId } = req.params;
  const { photo_type } = req.body;
  const allowed = ['main', 'location', 'site_plan', 'elevation', 'gallery'];
  if (!allowed.includes(photo_type)) return res.status(400).json({ error: 'Недопустимый тип' });
  try {
    // If setting main/location/site_plan/elevation — сбросить предыдущий с таким же типом
    if (photo_type !== 'gallery') {
      await pool.query(
        `UPDATE project_photos SET photo_type='gallery' WHERE project_id=$1 AND photo_type=$2`,
        [id, photo_type]
      );
    }
    // If setting main — also update projects.main_photo
    const { rows } = await pool.query(
      'UPDATE project_photos SET photo_type=$1 WHERE id=$2 AND project_id=$3 RETURNING *',
      [photo_type, photoId, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Фото не найдено' });
    if (photo_type === 'main') {
      await pool.query('UPDATE projects SET main_photo=$1 WHERE id=$2', [rows[0].filename, id]);
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// Engineering networks CRUD
// ============================================================
router.get('/:id/networks', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM engineering_networks WHERE project_id=$1 ORDER BY sort_order', [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

router.put('/:id/networks', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { networks } = req.body;
  const n = v => (v === '' || v == null) ? null : v;
  try {
    await pool.query('DELETE FROM engineering_networks WHERE project_id=$1', [id]);
    for (let i = 0; i < networks.length; i++) {
      const net = networks[i];
      await pool.query(
        'INSERT INTO engineering_networks (project_id, sort_order, name, specification) VALUES ($1,$2,$3,$4)',
        [id, i, n(net.name), n(net.specification)]
      );
    }
    const { rows } = await pool.query(
      'SELECT * FROM engineering_networks WHERE project_id=$1 ORDER BY sort_order', [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сохранения сетей' });
  }
});

module.exports = router;
