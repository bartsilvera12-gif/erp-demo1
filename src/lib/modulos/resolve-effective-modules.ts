import type { SupabaseClient } from "@supabase/supabase-js";

export type ModuloRow = { id: string; nombre: string; slug: string };

/**
 * Resuelve módulos efectivos para el usuario: intersección empresa (activo) ∩ usuario_modulos.
 * super_admin → todos los módulos del catálogo.
 */
export async function resolveEffectiveModules(
  supabase: SupabaseClient,
  usuario: { id: string; empresa_id: string | null; rol: string | null }
): Promise<ModuloRow[]> {
  const rol = (usuario.rol ?? "").trim();
  if (rol === "super_admin") {
    const { data, error } = await supabase.from("modulos").select("id, nombre, slug").order("slug");
    if (error) throw new Error(error.message);
    return (data ?? []).map((m) => ({
      id: m.id as string,
      nombre: (m.nombre as string) ?? "",
      slug: (m.slug as string) ?? "",
    }));
  }

  if (!usuario.empresa_id) {
    return [];
  }

  const { data: emData, error: errEm } = await supabase
    .from("empresa_modulos")
    .select("modulo_id")
    .eq("empresa_id", usuario.empresa_id)
    .eq("activo", true);

  if (errEm) throw new Error(errEm.message);
  const empresaModuloIds = [...new Set((emData ?? []).map((r) => r.modulo_id as string).filter(Boolean))];
  if (empresaModuloIds.length === 0) return [];

  const { data: umData, error: errUm } = await supabase
    .from("usuario_modulos")
    .select("modulo_id")
    .eq("usuario_id", usuario.id);

  if (errUm) throw new Error(errUm.message);
  const userIds = [...new Set((umData ?? []).map((r) => r.modulo_id as string).filter(Boolean))];

  let moduloIds: string[];
  if (userIds.length === 0) {
    moduloIds = [];
  } else {
    const empresaSet = new Set(empresaModuloIds);
    moduloIds = userIds.filter((id) => empresaSet.has(id));
  }

  if (moduloIds.length === 0) return [];

  const { data: modulos, error: errMod } = await supabase
    .from("modulos")
    .select("id, nombre, slug")
    .in("id", moduloIds)
    .order("slug");

  if (errMod) throw new Error(errMod.message);
  return (modulos ?? []).map((m) => ({
    id: m.id as string,
    nombre: (m.nombre as string) ?? "",
    slug: (m.slug as string) ?? "",
  }));
}

/** Filtra modulo_ids contra los habilitados para la empresa. */
export async function filterModuloIdsForEmpresa(
  supabase: SupabaseClient,
  empresaId: string,
  moduloIds: string[]
): Promise<string[]> {
  if (moduloIds.length === 0) return [];
  const { data, error } = await supabase
    .from("empresa_modulos")
    .select("modulo_id")
    .eq("empresa_id", empresaId)
    .eq("activo", true)
    .in("modulo_id", moduloIds);
  if (error) throw new Error(error.message);
  const allowed = new Set((data ?? []).map((r) => r.modulo_id as string));
  return moduloIds.filter((id) => allowed.has(id));
}
