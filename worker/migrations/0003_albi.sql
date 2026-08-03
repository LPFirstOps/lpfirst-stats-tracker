-- Albi (Albiware) integration ------------------------------------------------

CREATE TABLE `albi_config` (
  `organization_id` TEXT PRIMARY KEY REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `api_key` TEXT NOT NULL,
  `auth_header` TEXT,
  `enabled` INTEGER NOT NULL DEFAULT 1,
  `last_sync_at` INTEGER,
  `updated_at` INTEGER NOT NULL
);

CREATE TABLE `albi_projects` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `organization_id` TEXT NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `albi_id` TEXT NOT NULL,
  `name` TEXT,
  `status` TEXT,
  `address` TEXT,
  `received_date` TEXT,
  `payload` TEXT NOT NULL,
  `synced_at` INTEGER NOT NULL
);
CREATE UNIQUE INDEX `albi_projects_unique` ON `albi_projects` (`organization_id`, `albi_id`);
CREATE INDEX `albi_projects_status` ON `albi_projects` (`organization_id`, `status`);

CREATE TABLE `albi_project_kpis` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `organization_id` TEXT NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `albi_project_id` TEXT NOT NULL,
  `metric` TEXT NOT NULL,
  `value` REAL,
  `text_value` TEXT,
  `synced_at` INTEGER NOT NULL
);
CREATE UNIQUE INDEX `albi_kpis_unique` ON `albi_project_kpis` (`organization_id`, `albi_project_id`, `metric`);
CREATE INDEX `albi_kpis_metric` ON `albi_project_kpis` (`organization_id`, `metric`);

CREATE TABLE `albi_events` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `organization_id` TEXT NOT NULL,
  `scope` TEXT,
  `payload` TEXT NOT NULL,
  `received_at` INTEGER NOT NULL
);
