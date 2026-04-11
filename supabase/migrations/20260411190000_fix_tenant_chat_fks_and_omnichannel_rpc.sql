-- =============================================================================
-- 1) Corregir FKs en esquemas tenant er_* que sigan apuntando a zentra_erp para
--    tablas clonadas (p. ej. chat_conversations.channel_id → zentra_erp.chat_channels).
--    Eso provoca violación de FK al insertar conversaciones con canal solo en tenant.
-- 2) RPC en public para omnichannel_routes (evita depender de exposición PostgREST
--    de la tabla en schema cache).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reescribe FKs: mismas tablas referenciadas pero en el esquema tenant local.
-- Orden: primero chat_conversations, luego chat_messages (depende de conversaciones).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  newdef text;
  def0 text;
BEGIN
  FOR r IN
    SELECT
      tn.nspname::text AS schema_name,
      c.conname::text AS conname,
      c.oid AS coid,
      cf.relname::text AS from_table
    FROM pg_constraint c
    JOIN pg_class cf ON cf.oid = c.conrelid
    JOIN pg_namespace tn ON tn.oid = cf.relnamespace
    JOIN pg_class rt ON rt.oid = c.confrelid
    JOIN pg_namespace rn ON rn.oid = rt.relnamespace
    WHERE c.contype = 'f'
      AND tn.nspname ~ '^er_[0-9a-f]{32}$'
      AND rn.nspname = 'zentra_erp'
      AND cf.relname = 'chat_conversations'
      AND rt.relname IN (
        'chat_channels',
        'chat_contacts',
        'chat_queues',
        'chat_agents',
        'chat_flow_sessions'
      )
  LOOP
    def0 := pg_get_constraintdef(r.coid, true);
    newdef := replace(replace(def0, 'REFERENCES "zentra_erp".', 'REFERENCES ' || quote_ident(r.schema_name) || '.'), 'REFERENCES zentra_erp.', 'REFERENCES ' || quote_ident(r.schema_name) || '.');
    IF newdef = def0 THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I.chat_conversations DROP CONSTRAINT %I', r.schema_name, r.conname);
    EXECUTE format('ALTER TABLE %I.chat_conversations ADD CONSTRAINT %I %s', r.schema_name, r.conname, newdef);
  END LOOP;

  FOR r IN
    SELECT
      tn.nspname::text AS schema_name,
      c.conname::text AS conname,
      c.oid AS coid,
      cf.relname::text AS from_table
    FROM pg_constraint c
    JOIN pg_class cf ON cf.oid = c.conrelid
    JOIN pg_namespace tn ON tn.oid = cf.relnamespace
    JOIN pg_class rt ON rt.oid = c.confrelid
    JOIN pg_namespace rn ON rn.oid = rt.relnamespace
    WHERE c.contype = 'f'
      AND tn.nspname ~ '^er_[0-9a-f]{32}$'
      AND rn.nspname = 'zentra_erp'
      AND cf.relname = 'chat_messages'
      AND rt.relname = 'chat_conversations'
  LOOP
    def0 := pg_get_constraintdef(r.coid, true);
    newdef := replace(replace(def0, 'REFERENCES "zentra_erp".', 'REFERENCES ' || quote_ident(r.schema_name) || '.'), 'REFERENCES zentra_erp.', 'REFERENCES ' || quote_ident(r.schema_name) || '.');
    IF newdef = def0 THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I.chat_messages DROP CONSTRAINT %I', r.schema_name, r.conname);
    EXECUTE format('ALTER TABLE %I.chat_messages ADD CONSTRAINT %I %s', r.schema_name, r.conname, newdef);
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- RPC: lectura / sync / delete de omnichannel_routes (siempre vía public + SECURITY DEFINER)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neura_get_omnichannel_route(p_meta_phone_number_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = zentra_erp, pg_catalog
AS $$
  SELECT to_jsonb(r)
  FROM (
    SELECT empresa_id, channel_id, data_schema
    FROM omnichannel_routes
    WHERE meta_phone_number_id = btrim(p_meta_phone_number_id)
    LIMIT 1
  ) r;
$$;

CREATE OR REPLACE FUNCTION public.neura_sync_omnichannel_route(
  p_meta_phone_number_id text,
  p_empresa_id uuid,
  p_channel_id uuid,
  p_data_schema text,
  p_activo boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = zentra_erp, pg_catalog
AS $$
DECLARE
  ds text := coalesce(nullif(btrim(p_data_schema), ''), 'zentra_erp');
BEGIN
  IF NOT p_activo OR lower(ds) = 'zentra_erp' THEN
    DELETE FROM omnichannel_routes WHERE meta_phone_number_id = btrim(p_meta_phone_number_id);
    RETURN;
  END IF;

  INSERT INTO omnichannel_routes (meta_phone_number_id, empresa_id, channel_id, data_schema)
  VALUES (btrim(p_meta_phone_number_id), p_empresa_id, p_channel_id, ds)
  ON CONFLICT (meta_phone_number_id) DO UPDATE SET
    empresa_id = EXCLUDED.empresa_id,
    channel_id = EXCLUDED.channel_id,
    data_schema = EXCLUDED.data_schema,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.neura_delete_omnichannel_route(p_meta_phone_number_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = zentra_erp, pg_catalog
AS $$
BEGIN
  DELETE FROM omnichannel_routes WHERE meta_phone_number_id = btrim(p_meta_phone_number_id);
END;
$$;

REVOKE ALL ON FUNCTION public.neura_get_omnichannel_route(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neura_sync_omnichannel_route(text, uuid, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neura_delete_omnichannel_route(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.neura_get_omnichannel_route(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.neura_sync_omnichannel_route(text, uuid, uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.neura_delete_omnichannel_route(text) TO service_role;

COMMENT ON FUNCTION public.neura_get_omnichannel_route(text) IS
  'Webhook/UI: resolver phone_number_id → empresa/channel/schema sin PostgREST sobre omnichannel_routes.';
COMMENT ON FUNCTION public.neura_sync_omnichannel_route(text, uuid, uuid, text, boolean) IS
  'Upsert o borrar fila en zentra_erp.omnichannel_routes (tenant o desactivado).';
COMMENT ON FUNCTION public.neura_delete_omnichannel_route(text) IS
  'Elimina ruta omnicanal por meta_phone_number_id.';
