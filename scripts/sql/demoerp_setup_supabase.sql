-- ###########################################################################
-- #  SETUP COMPLETO DE BD — schema autónomo "demoerp" (clonado de "enlodemari")
-- #  Pegar en el editor SQL de Supabase (self-hosted) y ejecutar.
-- #
-- #  Secciones:
-- #    1) Funciones clonadoras            [OBLIGATORIO]
-- #    2) Ejecutar el clon                 [OBLIGATORIO]
-- #    3) Seed de catálogo (modulos/planes)[OPCIONAL - descomentar]
-- #    4) Exponer demoerp en la API        [REVISAR antes - descomentar]
-- #    5) Login / super-admin              [OPCIONAL - descomentar]
-- #    6) Verificación                     [OBLIGATORIO - es el SELECT final]
-- #
-- #  El clon NO copia datos (estructura vacía) y NO toca enlodemari.
-- ###########################################################################


-- ===========================================================================
-- 1) FUNCIONES CLONADORAS
-- ===========================================================================

-- Helper: reescribe prefijos de schema (src/zentra_erp/public) -> destino,
-- solo para los identificadores clonados (orden largo->corto).
CREATE OR REPLACE FUNCTION public._neura_rewrite_refs(
  p_expr text, p_src text, p_tgt text, p_tokens text[]
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  r text := p_expr;
  t text;
  pfx text;
  sorted text[];
  prefixes text[];
  v_tgt text := quote_ident(p_tgt);
BEGIN
  IF p_expr IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(x ORDER BY length(x) DESC), '{}')
  INTO sorted FROM unnest(p_tokens) AS x;
  SELECT array_agg(DISTINCT p)
  INTO prefixes
  FROM unnest(ARRAY[p_src, 'zentra_erp', 'public']) AS p
  WHERE p IS NOT NULL AND p <> p_tgt;
  IF prefixes IS NULL THEN
    RETURN r;
  END IF;
  FOREACH pfx IN ARRAY prefixes LOOP
    FOREACH t IN ARRAY sorted LOOP
      r := replace(r, pfx || '."' || t || '"', v_tgt || '."' || t || '"');
      r := replace(r, pfx || '.'  || t,        v_tgt || '.'  || t);
    END LOOP;
  END LOOP;
  RETURN r;
END;
$fn$;

-- Helper: clona funciones/RPC (plpgsql/sql, no neura_) en varias rondas.
CREATE OR REPLACE FUNCTION public._neura_clone_functions(
  p_src text, p_tgt text, p_tokens text[]
)
RETURNS int
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_tgt_i text := quote_ident(p_tgt);
  v_src_i text := quote_ident(p_src);
  fn_oid oid;
  fdef text;
  v_round int;
  v_now int;
  v_total int := 0;
BEGIN
  FOR v_round IN 1..25 LOOP
    v_now := 0;
    FOR fn_oid IN
      SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      WHERE n.nspname = p_src
        AND p.prokind IN ('f', 'p')
        AND l.lanname IN ('plpgsql', 'sql')
        -- Clonar TODAS las funciones, incl. neura_* (la app las usa por RPC)
    LOOP
      fdef := pg_get_functiondef(fn_oid);
      IF fdef IS NULL THEN CONTINUE; END IF;
      fdef := replace(fdef, 'FUNCTION ' || v_src_i || '.', 'FUNCTION ' || v_tgt_i || '.');
      fdef := replace(fdef, 'FUNCTION ' || p_src || '.', 'FUNCTION ' || v_tgt_i || '.');
      fdef := public._neura_rewrite_refs(fdef, p_src, p_tgt, p_tokens);
      fdef := replace(fdef, 'search_path = ' || p_src, 'search_path = ' || p_tgt);
      fdef := replace(fdef, 'search_path = zentra_erp', 'search_path = ' || p_tgt);
      fdef := replace(fdef, 'search_path=' || p_src, 'search_path=' || p_tgt);
      fdef := replace(fdef, 'search_path=zentra_erp', 'search_path=' || p_tgt);
      IF position('FUNCTION ' || v_tgt_i || '.' IN fdef) = 0 THEN CONTINUE; END IF;
      BEGIN
        EXECUTE fdef;
        v_now := v_now + 1;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;
    v_total := greatest(v_total, v_now);
    EXIT WHEN v_now = 0;
  END LOOP;
  RETURN v_total;
END;
$fn$;

-- Rutina principal: clona estructura completa src -> tgt (autónoma, vacía).
CREATE OR REPLACE FUNCTION public.neura_clone_schema_full(
  p_src text, p_tgt text, p_drop_if_exists boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_src text := p_src;
  v_tgt text := p_tgt;
  v_tgt_i text := quote_ident(p_tgt);
  v_src_i text := quote_ident(p_src);
  v_tables text[];
  v_tokens text[];
  v_pub text := 'supabase_realtime';
  tbl text;
  r RECORD;
  def text;
  idef text;
  tdef text;
  qual text;
  chk text;
  roles_clause text;
  v_pass int;
  v_viewdef text;
  v_default text;
  v_default_new text;
  n_tables int := 0;
  n_funcs int := 0;
  n_policies int := 0;
BEGIN
  IF v_src IS NULL OR v_src !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'schema origen inválido: %', v_src;
  END IF;
  IF v_tgt IS NULL OR v_tgt !~ '^[a-z_][a-z0-9_]*$' OR length(v_tgt) > 63 THEN
    RAISE EXCEPTION 'schema destino inválido: %', v_tgt;
  END IF;
  IF v_src = v_tgt THEN
    RAISE EXCEPTION 'origen y destino iguales: %', v_tgt;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_src) THEN
    RAISE EXCEPTION 'el schema origen % no existe', v_src;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_tgt) THEN
    IF p_drop_if_exists THEN
      EXECUTE format('DROP SCHEMA %I CASCADE', v_tgt);
    ELSE
      RAISE EXCEPTION 'el schema destino % ya existe (usar p_drop_if_exists=true)', v_tgt;
    END IF;
  END IF;

  SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname), '{}')
  INTO v_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = v_src AND c.relkind = 'r';
  IF coalesce(cardinality(v_tables), 0) = 0 THEN
    RAISE EXCEPTION 'el schema origen % no tiene tablas', v_src;
  END IF;

  SELECT coalesce(array_agg(DISTINCT name), '{}')
  INTO v_tokens
  FROM (
    SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = v_src AND c.relkind IN ('r','v','m')
    UNION
    SELECT p.proname::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = v_src
  ) s;

  EXECUTE format('CREATE SCHEMA %I', v_tgt);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO postgres, anon, authenticated, service_role', v_tgt);

  -- 1) tablas
  FOREACH tbl IN ARRAY v_tables LOOP
    EXECUTE format(
      'CREATE TABLE %I.%I (LIKE %I.%I '
      || 'INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY '
      || 'INCLUDING STATISTICS INCLUDING STORAGE INCLUDING COMMENTS '
      || 'EXCLUDING CONSTRAINTS EXCLUDING INDEXES)',
      v_tgt, tbl, v_src, tbl);
    n_tables := n_tables + 1;
  END LOOP;

  -- 2) funciones (1a pasada)
  PERFORM public._neura_clone_functions(v_src, v_tgt, v_tokens);

  -- 3) defaults que referencien schemas viejos
  FOR r IN
    SELECT c.relname::text AS tablename, a.attname::text AS colname,
           pg_get_expr(ad.adbin, ad.adrelid) AS expr
    FROM pg_attrdef ad
    JOIN pg_class c ON c.oid = ad.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    WHERE n.nspname = v_tgt
  LOOP
    v_default := r.expr;
    v_default_new := public._neura_rewrite_refs(v_default, v_src, v_tgt, v_tokens);
    IF v_default_new IS DISTINCT FROM v_default THEN
      BEGIN
        EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s',
          v_tgt, r.tablename, r.colname, v_default_new);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'clone: default %.% omitido: %', r.tablename, r.colname, SQLERRM;
      END;
    END IF;
  END LOOP;

  -- 4) PK/UNIQUE/CHECK
  FOR r IN
    SELECT c.oid, c.conname::text AS conname, cf.relname::text AS relname
    FROM pg_constraint c
    JOIN pg_class cf ON cf.oid = c.conrelid
    JOIN pg_namespace nf ON nf.oid = cf.relnamespace
    WHERE nf.nspname = v_src AND c.contype IN ('p','u','c') AND cf.relname = ANY (v_tables)
    ORDER BY CASE c.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 ELSE 4 END, c.conname
  LOOP
    def := public._neura_rewrite_refs(pg_get_constraintdef(r.oid), v_src, v_tgt, v_tokens);
    BEGIN
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', v_tgt, r.relname, r.conname, def);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'clone: constraint %.% omitido: %', r.relname, r.conname, SQLERRM;
    END;
  END LOOP;

  -- 5) índices
  FOR r IN
    SELECT pg_get_indexdef(i.oid) AS idef
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_index ix ON ix.indexrelid = i.oid
    JOIN pg_class t ON t.oid = ix.indrelid
    WHERE n.nspname = v_src AND i.relkind = 'i' AND ix.indisprimary IS FALSE
      AND NOT EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conindid = i.oid)
      AND t.relname = ANY (v_tables)
  LOOP
    idef := public._neura_rewrite_refs(r.idef, v_src, v_tgt, v_tokens);
    idef := replace(idef, ' ON ' || v_src_i || '.', ' ON ' || v_tgt_i || '.');
    BEGIN
      EXECUTE idef;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'clone: índice omitido: %', SQLERRM;
    END;
  END LOOP;

  -- 6) FKs
  FOR r IN
    SELECT c.oid, c.conname::text AS conname, cf.relname::text AS from_table
    FROM pg_constraint c
    JOIN pg_class cf ON cf.oid = c.conrelid
    JOIN pg_namespace nf ON nf.oid = cf.relnamespace
    WHERE nf.nspname = v_src AND c.contype = 'f' AND cf.relname = ANY (v_tables)
    ORDER BY c.conname
  LOOP
    def := public._neura_rewrite_refs(pg_get_constraintdef(r.oid), v_src, v_tgt, v_tokens);
    BEGIN
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', v_tgt, r.from_table, r.conname, def);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'clone: FK %.% omitido: %', r.from_table, r.conname, SQLERRM;
    END;
  END LOOP;

  -- 7) vistas
  FOR v_pass IN 1..12 LOOP
    FOR r IN
      SELECT c.relname::text AS vname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = v_src AND c.relkind = 'v'
    LOOP
      SELECT pg_get_viewdef(format('%I.%I', v_src, r.vname)::regclass, true) INTO v_viewdef;
      IF v_viewdef IS NULL THEN CONTINUE; END IF;
      v_viewdef := public._neura_rewrite_refs(v_viewdef, v_src, v_tgt, v_tokens);
      BEGIN
        EXECUTE format('DROP VIEW IF EXISTS %I.%I CASCADE', v_tgt, r.vname);
        EXECUTE format('CREATE VIEW %I.%I AS %s', v_tgt, r.vname, v_viewdef);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'clone: vista % pasada % omitida: %', r.vname, v_pass, SQLERRM;
      END;
    END LOOP;
  END LOOP;

  -- 8) matviews
  FOR r IN
    SELECT c.relname::text AS mname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'm'
  LOOP
    SELECT pg_get_viewdef(format('%I.%I', v_src, r.mname)::regclass, true) INTO v_viewdef;
    IF v_viewdef IS NULL THEN CONTINUE; END IF;
    v_viewdef := public._neura_rewrite_refs(v_viewdef, v_src, v_tgt, v_tokens);
    BEGIN
      EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS %I.%I CASCADE', v_tgt, r.mname);
      EXECUTE format('CREATE MATERIALIZED VIEW %I.%I AS %s WITH NO DATA', v_tgt, r.mname, v_viewdef);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'clone: matview % omitida: %', r.mname, SQLERRM;
    END;
  END LOOP;

  -- 9) funciones (2a pasada, tras vistas)
  PERFORM public._neura_clone_functions(v_src, v_tgt, v_tokens);
  SELECT count(*) INTO n_funcs FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = v_tgt;

  -- 10) triggers (no neura_)
  FOR r IN
    SELECT tg.tgname::text AS tgname, c.relname::text AS tablename,
           pg_get_triggerdef(tg.oid, true) AS tdef
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc pr ON pr.oid = tg.tgfoid
    WHERE n.nspname = v_src AND NOT tg.tgisinternal AND c.relname = ANY (v_tables)
      -- excluir triggers de plumbing/guard single-tenant (teardown, block_other_empresas, etc.)
      AND pr.proname !~ '^(neura_|_neura_)'
  LOOP
    tdef := public._neura_rewrite_refs(r.tdef, v_src, v_tgt, v_tokens);
    tdef := replace(tdef, ' ON ' || v_src_i || '.', ' ON ' || v_tgt_i || '.');
    BEGIN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', r.tgname, v_tgt, r.tablename);
      EXECUTE tdef;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'clone: trigger % en % omitido: %', r.tgname, r.tablename, SQLERRM;
    END;
  END LOOP;

  -- 11) RLS + policies
  FOREACH tbl IN ARRAY v_tables LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_tgt, tbl);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'clone: enable RLS % omitido: %', tbl, SQLERRM;
    END;
  END LOOP;

  FOR r IN
    SELECT pol.polname::text AS polname, c.relname::text AS tablename,
           pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
           pg_get_expr(pol.polqual, pol.polrelid) AS polqual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS polwithcheck,
           ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY (pol.polroles)) AS roles
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relname = ANY (v_tables)
  LOOP
    BEGIN
      qual := public._neura_rewrite_refs(r.polqual, v_src, v_tgt, v_tokens);
      chk  := public._neura_rewrite_refs(r.polwithcheck, v_src, v_tgt, v_tokens);
      IF r.roles IS NULL OR coalesce(cardinality(r.roles), 0) = 0 THEN
        roles_clause := '';
      ELSE
        roles_clause := ' TO ' || (SELECT string_agg(quote_ident(x), ', ') FROM unnest(r.roles) AS x);
      END IF;
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.polname, v_tgt, r.tablename);
      IF r.cmd = 'r' THEN
        EXECUTE format('CREATE POLICY %I ON %I.%I AS %s FOR SELECT%s USING (%s)',
          r.polname, v_tgt, r.tablename, CASE WHEN r.permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
          roles_clause, coalesce(qual, 'true'));
      ELSIF r.cmd = 'a' THEN
        EXECUTE format('CREATE POLICY %I ON %I.%I AS %s FOR INSERT%s WITH CHECK (%s)',
          r.polname, v_tgt, r.tablename, CASE WHEN r.permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
          roles_clause, coalesce(chk, qual, 'true'));
      ELSIF r.cmd = 'w' THEN
        EXECUTE format('CREATE POLICY %I ON %I.%I AS %s FOR UPDATE%s USING (%s) WITH CHECK (%s)',
          r.polname, v_tgt, r.tablename, CASE WHEN r.permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
          roles_clause, coalesce(qual, 'true'), coalesce(chk, qual, 'true'));
      ELSIF r.cmd = 'd' THEN
        EXECUTE format('CREATE POLICY %I ON %I.%I AS %s FOR DELETE%s USING (%s)',
          r.polname, v_tgt, r.tablename, CASE WHEN r.permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
          roles_clause, coalesce(qual, 'true'));
      ELSIF r.cmd = '*' THEN
        EXECUTE format('CREATE POLICY %I ON %I.%I AS %s FOR ALL%s USING (%s) WITH CHECK (%s)',
          r.polname, v_tgt, r.tablename, CASE WHEN r.permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
          roles_clause, coalesce(qual, 'true'), coalesce(chk, qual, 'true'));
      END IF;
      n_policies := n_policies + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'clone: policy % en % omitida: %', r.polname, r.tablename, SQLERRM;
    END;
  END LOOP;

  -- 12) grants
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO authenticated', v_tgt);
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO postgres, service_role', v_tgt);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated', v_tgt);
  EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO postgres, service_role', v_tgt);
  EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA %I TO authenticated, service_role', v_tgt);
  EXECUTE format('GRANT ALL ON ALL ROUTINES IN SCHEMA %I TO postgres, service_role', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT ALL ON TABLES TO postgres, service_role', v_tgt);

  -- 13) realtime
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = v_pub) THEN
    FOR r IN
      SELECT pt.tablename::text AS tablename FROM pg_publication_tables pt
      WHERE pt.pubname = v_pub AND pt.schemaname = v_src AND pt.tablename = ANY (v_tables)
    LOOP
      BEGIN
        EXECUTE format('ALTER PUBLICATION %I ADD TABLE %I.%I', v_pub, v_tgt, r.tablename);
      EXCEPTION
        WHEN duplicate_object THEN NULL;
        WHEN OTHERS THEN RAISE NOTICE 'clone: realtime % omitido: %', r.tablename, SQLERRM;
      END;
    END LOOP;
  END IF;

  PERFORM pg_notify('pgrst', 'reload schema');

  RETURN jsonb_build_object('ok', true, 'source', v_src, 'target', v_tgt,
    'tables', n_tables, 'functions', n_funcs, 'policies', n_policies);
END;
$fn$;


-- ===========================================================================
-- 2) EJECUTAR EL CLON  (enlodemari -> demoerp, estructura vacía)
-- ===========================================================================
SELECT public.neura_clone_schema_full('enlodemari', 'demoerp', false);
-- Para recrear desde cero si ya existe, usar:  ... 'demoerp', true);


-- ===========================================================================
-- 3) (OPCIONAL) SEED DE CATÁLOGO DE PRODUCTO  — descomentar si lo querés
--    (un schema 100% vacío no muestra módulos)
-- ===========================================================================
-- INSERT INTO demoerp.modulos SELECT * FROM enlodemari.modulos;
-- INSERT INTO demoerp.planes  SELECT * FROM enlodemari.planes;


-- ===========================================================================
-- 4) EXPONER demoerp EN LA API (PostgREST) — forma SQL-only (self-hosted)
--    La lista espeja tu supabase/config.toml + demoerp. Si en tu instalación
--    exponías otros schemas (ej. storage), agregálos a la lista de abajo.
--    Para ver la config actual antes de correr:
--      SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'authenticator';
-- ===========================================================================
ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, enlodemari, zentra_erp, demoerp';
ALTER ROLE authenticator SET pgrst.db_extra_search_path = 'enlodemari, public, extensions, zentra_erp, demoerp';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
-- Nota: si tu PostgREST se configura SOLO por env (ignora el rol), agregá demoerp a
-- PGRST_DB_SCHEMAS del servicio `rest` en docker-compose y reiniciá: docker compose restart rest


-- ===========================================================================
-- 5) (OPCIONAL) LOGIN / SUPER-ADMIN
--   Opción A (recomendada, deja el schema vacío): NO corras SQL.
--     En la app, configurá  NEXT_PUBLIC_SUPER_ADMIN_EMAILS=tu@email
--     (debe existir ese usuario en auth.users) y creá la empresa desde la UI.
--
--   Opción B (copiar 1 empresa + su admin desde enlodemari para entrar ya):
--     1) Listá empresas para elegir el UUID:
--          SELECT id, nombre_empresa FROM enlodemari.empresas ORDER BY nombre_empresa;
--     2) Reemplazá <EMPRESA_UUID> y descomentá:
-- ===========================================================================
-- INSERT INTO demoerp.empresas        SELECT * FROM enlodemari.empresas        WHERE id = '<EMPRESA_UUID>';
-- INSERT INTO demoerp.usuarios        SELECT * FROM enlodemari.usuarios        WHERE empresa_id = '<EMPRESA_UUID>';
-- INSERT INTO demoerp.empresa_modulos SELECT * FROM enlodemari.empresa_modulos WHERE empresa_id = '<EMPRESA_UUID>';
-- INSERT INTO demoerp.usuario_modulos SELECT * FROM enlodemari.usuario_modulos
--   WHERE usuario_id IN (SELECT id FROM enlodemari.usuarios WHERE empresa_id = '<EMPRESA_UUID>');


-- ===========================================================================
-- 6) VERIFICACIÓN  (resultado final que muestra el editor)
-- ===========================================================================
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='enlodemari' AND c.relkind='r') AS tablas_origen,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='demoerp'    AND c.relkind='r') AS tablas_destino,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='demoerp') AS funciones_destino,
  (SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='demoerp') AS policies_destino,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='demoerp' AND c.relkind='r' AND c.relrowsecurity) AS tablas_con_rls,
  (SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='demoerp') AS tablas_realtime,
  (SELECT count(*) FROM (
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='enlodemari' AND c.relkind='r'
      EXCEPT
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='demoerp' AND c.relkind='r'
   ) z) AS tablas_faltantes,
  (SELECT count(*) FROM pg_constraint c
     JOIN pg_class cf ON cf.oid=c.conrelid JOIN pg_namespace nf ON nf.oid=cf.relnamespace
     JOIN pg_class rt ON rt.oid=c.confrelid JOIN pg_namespace nrt ON nrt.oid=rt.relnamespace
   WHERE nf.nspname='demoerp' AND c.contype='f' AND nrt.nspname NOT IN ('demoerp','auth')) AS fks_colgando_de_viejo;
