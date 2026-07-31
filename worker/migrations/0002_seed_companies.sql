-- Seed the three portfolio companies. Slugs are the API/MCP identifiers and
-- must match scripts/sync-to-d1.js.
INSERT INTO `organization` (`id`, `name`, `slug`, `created_at`) VALUES
  ('org_aaction', 'A-Action', 'aaction', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('org_icon', 'Icon Restorative Services', 'icon', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('org_moyers', 'Moyer''s Services', 'moyers', CAST(strftime('%s','now') AS INTEGER) * 1000);

-- After your first sign-up, promote yourself to super admin and join all orgs:
--
--   UPDATE user SET role = 'admin' WHERE email = 'you@example.com';
--   INSERT INTO member (id, organization_id, user_id, role, created_at)
--     SELECT 'mem_' || o.slug, o.id, u.id, 'owner', CAST(strftime('%s','now') AS INTEGER) * 1000
--     FROM organization o, user u WHERE u.email = 'you@example.com';
--
-- (Run via: npx wrangler d1 execute lpfirst-stats --remote --command "...")
