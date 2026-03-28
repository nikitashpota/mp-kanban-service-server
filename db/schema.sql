-- Корпоративный портал проектной организации
-- Схема базы данных

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  role VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  inn VARCHAR(20),
  kpp VARCHAR(20),
  stage VARCHAR(50),              -- КП / П / РД / Завершён
  area_total NUMERIC(12,2),       -- Общая площадь, м²
  area_building NUMERIC(12,2),    -- Площадь застройки, м²
  area_underground NUMERIC(12,2), -- Площадь подземной части, м²
  floors_above INTEGER,           -- Этажей надземных
  floors_below INTEGER,           -- Этажей подземных
  height NUMERIC(8,2),            -- Высота, м
  completion_date VARCHAR(100),   -- Дата завершения (строкой, напр. "Март 2026")
  main_photo VARCHAR(255),        -- Главное фото (имя файла)
  description TEXT,
  gip_name VARCHAR(255),          -- ГИП
  gip_phone VARCHAR(50),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_photos (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_contacts (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  legal_entity VARCHAR(100),      -- Юр. лицо
  position VARCHAR(255),          -- Должность
  person_name VARCHAR(255),       -- ФИО
  phone VARCHAR(50),
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_stages (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  stage_code VARCHAR(10) NOT NULL,   -- АПР / П / РД
  stage_label VARCHAR(100),          -- Отображаемое название
  date_start DATE,                   -- Дата начала
  date_end DATE,                     -- Плановая дата завершения
  is_completed BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_tep (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  parameter_name VARCHAR(255) NOT NULL,
  value TEXT,
  unit VARCHAR(100),
  sort_order INTEGER DEFAULT 0
);

-- Триггер обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Создать admin-пользователя по умолчанию (пароль: admin123)
-- Обновить пароль после первого входа!
INSERT INTO users (username, password_hash, full_name, role)
VALUES ('admin', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Администратор', 'admin')
ON CONFLICT (username) DO NOTHING;