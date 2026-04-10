import { createSupabaseServerClient, createSupabaseServerClientWithDbSchema } from "@/lib/supabase/server";
import { SUPABASE_APP_SCHEMA, type AppSupabaseClient } from "@/lib/supabase/schema";

export type EmpresaUsuarioSession = {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  empresa_id: string;
  usuario_id: string;
};

/** Sesión para tablas omnicanal (chat_*): esquema tenant si `empresas.data_schema` está definido. */
export type EmpresaChatSession = {
  supabase: AppSupabaseClient;
  catalogSupabase: AppSupabaseClient;
  empresa_id: string;
  usuario_id: string;
  dataSchema: string;
};

/**
 * Usuario autenticado (auth) alineado a `zentra_erp.usuarios` de su empresa.
 */
export async function requireEmpresaUsuarioSession(): Promise<EmpresaUsuarioSession> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    throw new Error("Usuario no autenticado o sin empresa");
  }
  const { data: rows, error } = await supabase
    .from("usuarios")
    .select("id, empresa_id")
    .eq("email", user.email)
    .limit(1);
  if (error) throw new Error(error.message);
  const data = rows?.[0] as { id?: string; empresa_id?: string } | undefined;
  const empresa_id = data?.empresa_id;
  const usuario_id = data?.id;
  if (!empresa_id || typeof empresa_id !== "string" || !usuario_id || typeof usuario_id !== "string") {
    throw new Error("Usuario no autenticado o sin empresa");
  }
  return { supabase, empresa_id, usuario_id };
}

/**
 * Catálogo (usuarios, empresas) en zentra_erp; datos de chat en `data_schema` de la empresa o zentra_erp.
 */
export async function requireEmpresaChatSession(): Promise<EmpresaChatSession> {
  const catalogSupabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await catalogSupabase.auth.getUser();
  if (!user?.email) {
    throw new Error("Usuario no autenticado o sin empresa");
  }
  const { data: rows, error } = await catalogSupabase
    .from("usuarios")
    .select("id, empresa_id")
    .eq("email", user.email)
    .limit(1);
  if (error) throw new Error(error.message);
  const data = rows?.[0] as { id?: string; empresa_id?: string } | undefined;
  const empresa_id = data?.empresa_id;
  const usuario_id = data?.id;
  if (!empresa_id || typeof empresa_id !== "string" || !usuario_id || typeof usuario_id !== "string") {
    throw new Error("Usuario no autenticado o sin empresa");
  }

  const { data: empRow } = await catalogSupabase
    .from("empresas")
    .select("data_schema")
    .eq("id", empresa_id)
    .maybeSingle();

  const ds = (empRow as { data_schema?: string | null } | null)?.data_schema?.trim();
  const dataSchema = ds && ds.length > 0 ? ds : SUPABASE_APP_SCHEMA;

  const supabase: AppSupabaseClient =
    dataSchema === SUPABASE_APP_SCHEMA
      ? (catalogSupabase as AppSupabaseClient)
      : ((await createSupabaseServerClientWithDbSchema(dataSchema)) as AppSupabaseClient);

  return { supabase, catalogSupabase: catalogSupabase as AppSupabaseClient, empresa_id, usuario_id, dataSchema };
}
