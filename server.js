require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const usersRoutes = require('./routes/users');
const passportRoutes = require('./routes/passport');
const kanbanRoutes = require('./routes/kanban');
const projectTypesRoutes = require('./routes/project_types');
const analyticsRoutes = require('./routes/analytics');
const { pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Статика: загруженные фото
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Routes ───────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/passport', passportRoutes);
app.use('/api/kanban', kanbanRoutes);
app.use('/api/project-types', projectTypesRoutes);
app.use('/api/analytics', analyticsRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─── Start ────────────────────────────────────────────────────
async function initDb() {
  // Создаём каждую таблицу отдельным запросом — pg не поддерживает multi-statement
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(255),
      role VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      address TEXT, inn VARCHAR(20), kpp VARCHAR(20),
      stage VARCHAR(50),
      area_total NUMERIC(12,2), area_building NUMERIC(12,2), area_underground NUMERIC(12,2),
      floors_above INTEGER, floors_below INTEGER, height NUMERIC(8,2),
      completion_date VARCHAR(100), main_photo VARCHAR(255), description TEXT,
      gip_name VARCHAR(255), gip_phone VARCHAR(50),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS project_photos (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      filename VARCHAR(255) NOT NULL,
      photo_type VARCHAR(30) DEFAULT 'gallery',
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    // migrate existing rows that lack photo_type
    `ALTER TABLE project_photos ADD COLUMN IF NOT EXISTS photo_type VARCHAR(30) DEFAULT 'gallery'`,
    `CREATE TABLE IF NOT EXISTS project_contacts (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      legal_entity VARCHAR(100), position VARCHAR(255),
      person_name VARCHAR(255), phone VARCHAR(50), email VARCHAR(255),
      sort_order INTEGER DEFAULT 0
    )`,
    `ALTER TABLE project_contacts ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,
    `CREATE TABLE IF NOT EXISTS project_tep (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      parameter_name VARCHAR(255) NOT NULL,
      value TEXT, unit VARCHAR(100), sort_order INTEGER DEFAULT 0
    )`,
    `CREATE OR REPLACE FUNCTION update_updated_at()
     RETURNS TRIGGER AS $$
     BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS projects_updated_at ON projects`,
    `CREATE TRIGGER projects_updated_at
     BEFORE UPDATE ON projects
     FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ('admin', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Администратор', 'admin')
     ON CONFLICT (username) DO NOTHING`,
    // ── Паспорт проекта ──
    `CREATE TABLE IF NOT EXISTS project_passport (
      id SERIAL PRIMARY KEY,
      project_id INTEGER UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      customer TEXT,
      functional_customer TEXT,
      general_designer TEXT,
      developer TEXT,
      aip_cost TEXT,
      completion_date TEXT,
      contract_pir TEXT,
      area_total TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS passport_stages (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      stage_num VARCHAR(10),
      stage_name TEXT,
      sub_stage_name TEXT,
      readiness INTEGER DEFAULT 0,
      deadline_contract DATE,
      deadline_directive DATE,
      execution_planned DATE,
      execution_actual DATE,
      responsible TEXT,
      note TEXT,
      kanban_status VARCHAR(30) DEFAULT NULL
    )`,
    `ALTER TABLE passport_stages ADD COLUMN IF NOT EXISTS kanban_status VARCHAR(30) DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS passport_issues (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      problem TEXT,
      solution TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS engineering_networks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      name TEXT,
      specification TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS project_types (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      color VARCHAR(20) DEFAULT '#6b7280',
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type_id INTEGER REFERENCES project_types(id) ON DELETE SET NULL`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_terminated BOOLEAN DEFAULT false`,
    `ALTER TABLE passport_stages ADD COLUMN IF NOT EXISTS kanban_status_2 VARCHAR(30) DEFAULT NULL`,
    `ALTER TABLE passport_stages ADD COLUMN IF NOT EXISTS execution_planned_2 DATE DEFAULT NULL`,
    `ALTER TABLE passport_stages ADD COLUMN IF NOT EXISTS execution_actual_2 DATE DEFAULT NULL`,
    `ALTER TABLE project_types ADD COLUMN IF NOT EXISTS is_renovation BOOLEAN DEFAULT false`,
    `ALTER TABLE project_types ADD COLUMN IF NOT EXISTS kanban_type VARCHAR(20) DEFAULT 'administrative'`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }

  // ── Migration: merge ТИМ-модель + Консультационные услуги → КУ ТИМ (заход/выход) ──
  await pool.query(`
    UPDATE passport_stages
    SET stage_name = 'КУ ТИМ', sub_stage_name = 'заход', stage_num = NULL
    WHERE stage_num = '20'
      AND (stage_name ILIKE '%консульт%' OR stage_name ILIKE '%услуг%')
      AND sub_stage_name IS NULL
  `);
  // Insert выход row after заход if missing
  await pool.query(`
    INSERT INTO passport_stages (project_id, sort_order, stage_num, stage_name, sub_stage_name)
    SELECT z.project_id, z.sort_order + 1, '20', NULL, 'выход'
    FROM passport_stages z
    WHERE z.stage_name = 'КУ ТИМ' AND z.sub_stage_name = 'заход'
      AND NOT EXISTS (
        SELECT 1 FROM passport_stages v
        WHERE v.project_id = z.project_id
          AND v.sub_stage_name = 'выход'
          AND v.stage_num = '20'
      )
  `);

  console.log('✅ Схема применена');
}

initDb()
  .catch(e => console.error('❌ Ошибка схемы:', e.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
    });
  });
