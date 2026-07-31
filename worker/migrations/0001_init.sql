-- Better Auth core -----------------------------------------------------------

CREATE TABLE `user` (
  `id` TEXT PRIMARY KEY,
  `name` TEXT NOT NULL,
  `email` TEXT NOT NULL UNIQUE,
  `email_verified` INTEGER NOT NULL DEFAULT 0,
  `image` TEXT,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  `role` TEXT,
  `banned` INTEGER,
  `ban_reason` TEXT,
  `ban_expires` INTEGER
);

CREATE TABLE `session` (
  `id` TEXT PRIMARY KEY,
  `expires_at` INTEGER NOT NULL,
  `token` TEXT NOT NULL UNIQUE,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  `ip_address` TEXT,
  `user_agent` TEXT,
  `user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `impersonated_by` TEXT,
  `active_organization_id` TEXT
);

CREATE TABLE `account` (
  `id` TEXT PRIMARY KEY,
  `account_id` TEXT NOT NULL,
  `provider_id` TEXT NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `access_token` TEXT,
  `refresh_token` TEXT,
  `id_token` TEXT,
  `access_token_expires_at` INTEGER,
  `refresh_token_expires_at` INTEGER,
  `scope` TEXT,
  `password` TEXT,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);

CREATE TABLE `verification` (
  `id` TEXT PRIMARY KEY,
  `identifier` TEXT NOT NULL,
  `value` TEXT NOT NULL,
  `expires_at` INTEGER NOT NULL,
  `created_at` INTEGER,
  `updated_at` INTEGER
);

-- Organization plugin (companies) ---------------------------------------------

CREATE TABLE `organization` (
  `id` TEXT PRIMARY KEY,
  `name` TEXT NOT NULL,
  `slug` TEXT NOT NULL UNIQUE,
  `logo` TEXT,
  `created_at` INTEGER NOT NULL,
  `metadata` TEXT
);

CREATE TABLE `member` (
  `id` TEXT PRIMARY KEY,
  `organization_id` TEXT NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `role` TEXT NOT NULL DEFAULT 'member',
  `created_at` INTEGER NOT NULL
);

CREATE TABLE `invitation` (
  `id` TEXT PRIMARY KEY,
  `organization_id` TEXT NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `email` TEXT NOT NULL,
  `role` TEXT,
  `status` TEXT NOT NULL DEFAULT 'pending',
  `expires_at` INTEGER NOT NULL,
  `inviter_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE
);

-- MCP / OIDC provider plugin --------------------------------------------------

CREATE TABLE `oauth_application` (
  `id` TEXT PRIMARY KEY,
  `name` TEXT,
  `icon` TEXT,
  `metadata` TEXT,
  `client_id` TEXT UNIQUE,
  `client_secret` TEXT,
  `redirect_u_r_ls` TEXT,
  `type` TEXT,
  `disabled` INTEGER,
  `user_id` TEXT,
  `created_at` INTEGER,
  `updated_at` INTEGER
);

CREATE TABLE `oauth_access_token` (
  `id` TEXT PRIMARY KEY,
  `access_token` TEXT UNIQUE,
  `refresh_token` TEXT UNIQUE,
  `access_token_expires_at` INTEGER,
  `refresh_token_expires_at` INTEGER,
  `client_id` TEXT,
  `user_id` TEXT,
  `scopes` TEXT,
  `created_at` INTEGER,
  `updated_at` INTEGER
);

CREATE TABLE `oauth_consent` (
  `id` TEXT PRIMARY KEY,
  `client_id` TEXT,
  `user_id` TEXT,
  `scopes` TEXT,
  `created_at` INTEGER,
  `updated_at` INTEGER,
  `consent_given` INTEGER
);

-- Domain ----------------------------------------------------------------------

CREATE TABLE `snapshots` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `organization_id` TEXT NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `source` TEXT NOT NULL,
  `location` TEXT NOT NULL DEFAULT '',
  `date` TEXT NOT NULL,
  `payload` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL
);
CREATE UNIQUE INDEX `snapshots_unique` ON `snapshots` (`organization_id`, `source`, `location`, `date`);
CREATE INDEX `snapshots_org_source` ON `snapshots` (`organization_id`, `source`, `date`);

CREATE TABLE `metrics` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `organization_id` TEXT NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `source` TEXT NOT NULL,
  `location` TEXT NOT NULL DEFAULT '',
  `date` TEXT NOT NULL,
  `tab` TEXT NOT NULL DEFAULT '',
  `assignment_type` TEXT NOT NULL DEFAULT '',
  `metric` TEXT NOT NULL,
  `value` REAL,
  `text_value` TEXT,
  `updated_at` INTEGER NOT NULL
);
CREATE UNIQUE INDEX `metrics_unique` ON `metrics` (`organization_id`, `source`, `location`, `date`, `tab`, `assignment_type`, `metric`);
CREATE INDEX `metrics_org_date` ON `metrics` (`organization_id`, `date`);
CREATE INDEX `metrics_lookup` ON `metrics` (`organization_id`, `source`, `metric`, `date`);
