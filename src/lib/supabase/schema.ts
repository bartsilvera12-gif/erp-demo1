import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Esquema Postgres de datos del ERP.
 *
 * Requiere en Supabase: Settings → API → "Exposed schemas" incluir `zentra_erp`
 * (además de lo que ya tengas para auth/storage).
 */
export const SUPABASE_APP_SCHEMA = "zentra_erp" as const;

/**
 * Cliente Supabase con cualquier esquema PostgREST (`zentra_erp`, `erp_*`, etc.).
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
