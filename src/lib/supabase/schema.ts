import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Instancia dedicada monocliente (En lo de Mari).
 * Schema único Postgres para catálogo + datos operativos.
 * Override opcional vía NEURA_CLIENT_SCHEMA si se reusa el repo para otro cliente.
 */
export const NEURA_CLIENT_SCHEMA: string =
  (typeof process !== "undefined" &&
    // En el navegador SOLO existen las vars NEXT_PUBLIC_*; por eso el cliente browser
    // necesita NEXT_PUBLIC_NEURA_CLIENT_SCHEMA (si no, cae al default y consulta el schema
    // equivocado). En el server alcanza con NEURA_CLIENT_SCHEMA.
    (process.env.NEURA_CLIENT_SCHEMA?.trim() ||
      process.env.NEXT_PUBLIC_NEURA_CLIENT_SCHEMA?.trim())) ||
  "demoerp";

/**
 * Schema Postgres principal de la app.
 * En instancia dedicada equivale a NEURA_CLIENT_SCHEMA.
 * Requiere en Supabase: Settings → API → "Exposed schemas" incluir este schema.
 */
export const SUPABASE_APP_SCHEMA: string = NEURA_CLIENT_SCHEMA;

/**
 * Resolución de schema operativo por empresa.
 * En instancia dedicada monocliente siempre devuelve el schema único; el argumento se ignora.
 * Se mantiene la firma para compatibilidad con callers existentes.
 */
export function resolveEmpresaDataSchema(_dataSchema?: string | null): string {
  return NEURA_CLIENT_SCHEMA;
}

/**
 * Cliente Supabase con cualquier esquema PostgREST.
 * Con @supabase/supabase-js ≥2.99 los genéricos de `SupabaseClient` son varios y condicionales;
 * acotar alguno a `string` o `"public"` rompe la asignación entre instancias (p. ej. Vercel TS).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppSupabaseClient = SupabaseClient<any, any, any, any, any>;

export const supabaseDbSchemaOption = {
  db: { schema: SUPABASE_APP_SCHEMA },
} as const;

/** Cliente service role estándar (API routes, webhooks, jobs). */
export const supabaseServiceRoleClientOptions = {
  auth: { autoRefreshToken: false, persistSession: false },
  ...supabaseDbSchemaOption,
} as const;
