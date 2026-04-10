import { createSupabaseServerClient, createSupabaseServerClientWithDbSchema } from "@/lib/supabase/server";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";

/** PostgREST schema de datos ERP (`empresas.data_schema` o plantilla legada). */
export async function resolveDataSchemaForCurrentUserServer(): Promise<string> {
  const catalog = await createSupabaseServerClient();
  const {
    data: { user },
  } = await catalog.auth.getUser();
  if (!user?.email) {
    return SUPABASE_APP_SCHEMA;
  }

  const { data: urows } = await catalog
    .from("usuarios")
    .select("empresa_id")
    .eq("email", user.email)
    .limit(1);

  const empresaId = (urows?.[0] as { empresa_id?: string } | undefined)?.empresa_id;
  if (!empresaId) {
    return SUPABASE_APP_SCHEMA;
  }

  const { data: emp } = await catalog
    .from("empresas")
    .select("data_schema")
    .eq("id", empresaId)
    .maybeSingle();

  const ds = (emp as { data_schema?: string | null } | null)?.data_schema?.trim();
  if (ds && ds.length > 0) return ds;
  return SUPABASE_APP_SCHEMA;
}

/** Cliente servidor con sesión del usuario y tablas de negocio en el schema de la empresa. */
export async function createSupabaseServerClientForEmpresaData() {
  const schema = await resolveDataSchemaForCurrentUserServer();
  return createSupabaseServerClientWithDbSchema(schema);
}
