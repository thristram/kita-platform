-- OIDC identities are distinct from KitaCon authorization. A principal may
-- retain grants when a future production provider is linked to the same ID.
CREATE TABLE admin.principal_identity (
  auth_issuer text NOT NULL,
  auth_subject text NOT NULL,
  principal_id uuid NOT NULL REFERENCES admin.principal(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (auth_issuer, auth_subject)
);

INSERT INTO admin.principal_identity (auth_issuer, auth_subject, principal_id)
SELECT auth_issuer, auth_subject, id FROM admin.principal
ON CONFLICT DO NOTHING;

CREATE INDEX principal_identity_principal_idx ON admin.principal_identity(principal_id);

CREATE TABLE admin.permission_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  system boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin.principal_group (
  principal_id uuid NOT NULL REFERENCES admin.principal(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES admin.permission_group(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES admin.principal(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, group_id)
);

CREATE INDEX principal_group_group_idx ON admin.principal_group(group_id);

INSERT INTO admin.permission_group (key, name, description, permissions) VALUES
  ('owner', 'Owner', 'Manage all Console content, operators and access grants.', ARRAY['console:read','events:write','candidates:review','sources:write','jobs:write','settings:write','access:manage']),
  ('editor', 'Editor', 'Create and edit events, candidates, sources and jobs.', ARRAY['console:read','events:write','candidates:review','sources:write','jobs:write']),
  ('reviewer', 'Reviewer', 'Review candidates and update event content.', ARRAY['console:read','events:write','candidates:review']),
  ('operator', 'Operator', 'Manage sources and crawler/resolution jobs.', ARRAY['console:read','sources:write','jobs:write']),
  ('viewer', 'Viewer', 'Read Console data without changing it.', ARRAY['console:read']);

-- Keep owner checks, mutation and audit in one database transaction/statement.
CREATE FUNCTION admin.set_permission_group(p_actor uuid, p_principal uuid, p_group_key text, p_enabled boolean)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_group uuid;
  v_changed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kitacon-permission-grants'));
  IF NOT EXISTS (
    SELECT 1 FROM admin.principal actor
    JOIN admin.principal_group pg ON pg.principal_id = actor.id
    JOIN admin.permission_group g ON g.id = pg.group_id
    WHERE actor.id = p_actor AND actor.status = 'ACTIVE' AND 'access:manage' = ANY(g.permissions)
  ) THEN RETURN 'PERMISSION_DENIED'; END IF;
  SELECT id INTO v_group FROM admin.permission_group WHERE key = p_group_key;
  IF v_group IS NULL THEN RETURN 'GROUP_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM admin.principal WHERE id = p_principal) THEN RETURN 'PRINCIPAL_NOT_FOUND'; END IF;
  IF NOT p_enabled AND p_group_key = 'owner' THEN
    IF p_actor = p_principal THEN RETURN 'CANNOT_REMOVE_OWN_OWNER_GROUP'; END IF;
    IF (SELECT count(*) FROM admin.principal_group pg JOIN admin.permission_group g ON g.id = pg.group_id JOIN admin.principal p ON p.id = pg.principal_id WHERE g.key = 'owner' AND p.status = 'ACTIVE') <= 1
      THEN RETURN 'CANNOT_REMOVE_LAST_OWNER'; END IF;
  END IF;
  IF p_enabled THEN
    INSERT INTO admin.principal_group (principal_id, group_id, granted_by)
    VALUES (p_principal, v_group, p_actor) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM admin.principal_group WHERE principal_id = p_principal AND group_id = v_group;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed > 0 THEN
    INSERT INTO admin.audit_log (principal_id, operation, target_type, target_id, after)
    VALUES (p_actor, CASE WHEN p_enabled THEN 'GRANT_GROUP' ELSE 'REVOKE_GROUP' END,
      'admin.principal', p_principal, jsonb_build_object('group', p_group_key, 'enabled', p_enabled));
  END IF;
  RETURN NULL;
END;
$$;
