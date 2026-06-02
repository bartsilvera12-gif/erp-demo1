/**
 * Clona la estructura completa de un schema ERP (por defecto `enlodemari`) a un
 * schema nuevo, 100% autónomo y VACÍO (sin datos), en tu Postgres self-hosted.
 *
 * Requiere SUPABASE_DB_URL en .env.local (conexión directa de superusuario/postgres).
 *
 * Uso:
 *   node scripts/clone-erp-schema.cjs --target erp_nuevo
 *   node scripts/clone-erp-schema.cjs --target erp_nuevo --source enlodemari
 *   node scripts/clone-erp-schema.cjs --target erp_nuevo --drop        (recrea si existe)
 *   node scripts/clone-erp-schema.cjs --target erp_nuevo --verify-only (solo verifica)
 *   node scripts/clone-erp-schema.cjs --target erp_nuevo --seed-catalog (copia modulos/planes)
 *   node scripts/clone-erp-schema.cjs --target erp_nuevo --seed-catalog --seed-tables modulos,planes
 *
 * Nota: --seed-catalog copia SOLO tablas de catálogo/referencia de producto
 * (no datos de cliente). Útil porque un schema 100% vacío no muestra módulos.
 */
const fs = require("fs");
const path = require("path");
const { config } = require("dotenv");
const pg = require("pg");

config({ path: path.resolve(process.cwd(), ".env.local") });

function parseArgs(argv) {
  const out = {
    source: "enlodemari", target: null, drop: false, verifyOnly: false,
    seedCatalog: false, seedTables: ["modulos", "planes"],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target" || a === "-t") out.target = argv[++i];
    else if (a === "--source" || a === "-s") out.source = argv[++i];
    else if (a === "--drop") out.drop = true;
    else if (a === "--verify-only") out.verifyOnly = true;
    else if (a === "--seed-catalog") out.seedCatalog = true;
    else if (a === "--seed-tables") out.seedTables = String(argv[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
  }
  return out;
}

const args = parseArgs(process.argv);
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

if (!args.target) {
  console.error("Falta --target <nombre_schema>.  Ej: node scripts/clone-erp-schema.cjs --target erp_nuevo");
  process.exit(2);
}
if (!SCHEMA_RE.test(args.target) || args.target.length > 63) {
  console.error(`Nombre de schema destino inválido: ${args.target} (usar [a-z_][a-z0-9_]*, máx 63).`);
  process.exit(2);
}
if (!SCHEMA_RE.test(args.source)) {
  console.error(`Nombre de schema origen inválido: ${args.source}`);
  process.exit(2);
}

const url = process.env.SUPABASE_DB_URL?.trim();
if (!url) {
  console.error("Falta SUPABASE_DB_URL en .env.local (conexión directa a Postgres).");
  process.exit(2);
}

const FN_SQL = path.resolve(process.cwd(), "scripts/sql/neura_clone_schema_full.sql");

async function verify(client, source, target) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;

  const exists = (await q(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [target])).length > 0;
  if (!exists) {
    console.error(`✗ El schema destino "${target}" no existe.`);
    return false;
  }

  const counts = await q(
    `SELECT
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r') AS src_tables,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relkind='r') AS tgt_tables,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1) AS src_funcs,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$2) AS tgt_funcs,
       (SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) AS src_pol,
       (SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2) AS tgt_pol,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relkind='r' AND c.relrowsecurity) AS tgt_rls,
       (SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname=$2) AS tgt_realtime`,
    [source, target]
  );
  const c = counts[0];

  // Tablas faltantes en destino
  const missing = await q(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relkind='r'
         AND c.relname NOT IN (
           SELECT c2.relname FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid=c2.relnamespace
            WHERE n2.nspname=$2 AND c2.relkind='r')
       ORDER BY c.relname`,
    [source, target]
  );

  // FKs que apunten FUERA del schema destino (excepto auth) = dependencia no deseada.
  // Se resuelve por catálogo (confrelid), no por texto, para no depender del search_path.
  const danglingFks = await q(
    `SELECT cf.relname AS tabla, c.conname, nrt.nspname AS ref_schema, rt.relname AS ref_table
       FROM pg_constraint c
       JOIN pg_class cf ON cf.oid=c.conrelid
       JOIN pg_namespace nf ON nf.oid=cf.relnamespace
       JOIN pg_class rt ON rt.oid=c.confrelid
       JOIN pg_namespace nrt ON nrt.oid=rt.relnamespace
      WHERE nf.nspname=$1 AND c.contype='f'
        AND nrt.nspname NOT IN ($1, 'auth')
      ORDER BY cf.relname, c.conname`,
    [target]
  );

  // Filas totales (debe ser 0: estructura vacía)
  let totalRows = 0;
  const tnames = (await q(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`, [target])).map(r => r.relname);
  for (const t of tnames) {
    const rc = await q(`SELECT count(*)::int AS n FROM "${target}"."${t.replace(/"/g, '""')}"`);
    totalRows += rc[0].n;
  }

  console.log("\n──────────── VERIFICACIÓN ────────────");
  console.log(`Schema destino     : ${target}  (existe ✓)`);
  console.log(`Tablas             : ${c.tgt_tables} / ${c.src_tables} (destino/origen)`);
  console.log(`Funciones          : ${c.tgt_funcs} / ${c.src_funcs}`);
  console.log(`Policies RLS        : ${c.tgt_pol} / ${c.src_pol}`);
  console.log(`Tablas con RLS ON  : ${c.tgt_rls}`);
  console.log(`Tablas en realtime : ${c.tgt_realtime}`);
  console.log(`Filas totales      : ${totalRows} (esperado 0 = estructura vacía)`);
  console.log(`Tablas faltantes   : ${missing.length}${missing.length ? " → " + missing.map(m => m.relname).join(", ") : ""}`);
  console.log(`FKs colgando viejo : ${danglingFks.length}${danglingFks.length ? " ⚠" : " ✓"}`);
  if (danglingFks.length) {
    for (const f of danglingFks.slice(0, 20)) console.log(`   - ${f.tabla}.${f.conname} → ${f.ref_schema}.${f.ref_table}`);
  }
  console.log("──────────────────────────────────────\n");

  const ok = missing.length === 0 && danglingFks.length === 0 && Number(c.tgt_tables) === Number(c.src_tables);
  console.log(ok ? "✓ Clon verificado OK." : "⚠ Revisá las advertencias de arriba.");
  return ok;
}

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

async function seedCatalog(client, source, target, tables) {
  console.log(`→ Seeding catálogo (${tables.join(", ")}): ${source} → ${target}…`);
  for (const t of tables) {
    if (!TABLE_RE.test(t)) { console.log(`   ⚠ tabla inválida, omitida: ${t}`); continue; }
    const inTgt = (await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r'`,
      [target, t])).rowCount > 0;
    const inSrc = (await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r'`,
      [source, t])).rowCount > 0;
    if (!inSrc) { console.log(`   - ${t}: no existe en origen, omitida`); continue; }
    if (!inTgt) { console.log(`   - ${t}: no existe en destino, omitida`); continue; }
    try {
      const r = await client.query(`INSERT INTO "${target}"."${t}" SELECT * FROM "${source}"."${t}"`);
      console.log(`   - ${t}: ${r.rowCount} filas copiadas`);
    } catch (e) {
      console.log(`   - ${t}: ⚠ ${e.message}`);
    }
  }
}

async function main() {
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes("supabase") || url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  // Mostrar NOTICES del servidor (progreso/omisiones del clonador)
  client.on("notice", (n) => { if (n?.message) console.log("  [pg] " + n.message); });

  try {
    if (args.verifyOnly) {
      const ok = await verify(client, args.source, args.target);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    console.log(`→ Cargando función clonadora (${path.relative(process.cwd(), FN_SQL)})…`);
    await client.query(fs.readFileSync(FN_SQL, "utf8"));

    console.log(`→ Clonando estructura: ${args.source} → ${args.target}${args.drop ? " (drop si existe)" : ""}…`);
    const res = await client.query(
      `SELECT public.neura_clone_schema_full($1, $2, $3) AS r`,
      [args.source, args.target, args.drop]
    );
    console.log("→ Resultado:", JSON.stringify(res.rows[0].r));

    if (args.seedCatalog) {
      await seedCatalog(client, args.source, args.target, args.seedTables);
    }

    const ok = await verify(client, args.source, args.target);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error("✗ Error:", e.message || e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
