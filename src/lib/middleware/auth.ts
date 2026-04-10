import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { supabaseDbSchemaOption, supabaseServiceRoleClientOptions } from "@/lib/supabase/schema";

export interface UsuarioConEmpresa {
  user: User;
  empresa_id: string;
}

export interface UsuarioConEmpresaYRol extends UsuarioConEmpresa {
  rol?: string;
  nombre?: string;
}

function esRolAdmin(rol?: string): boolean {
  return rol === "admin" || rol === "administrador" || rol === "super_admin";
}

/**
 * Obtiene el usuario autenticado, empresa_id y rol (para validación admin).
 */
export async function getAuthWithRol(): Promise<UsuarioConEmpresaYRol | null> {
  const base = await getUserAndEmpresa();
  if (!base) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return base;
  const supabase = createClient(url, serviceKey, { ...supabaseServiceRoleClientOptions });
  const { data } = await supabase
    .from("usuarios")
    .select("rol, nombre")
    .eq("email", base.user.email)
    .maybeSingle();
  return {
    ...base,
    rol: (data as { rol?: string })?.rol,
    nombre: (data as { nombre?: string })?.nombre,
  };
}

export function isAdmin(auth: UsuarioConEmpresaYRol | null): boolean {
  return !!auth && esRolAdmin(auth.rol);
}

/**
 * Obtiene el usuario autenticado y su empresa_id.
 * Requerido para todas las rutas API multiempresa.
 *
 * @returns { user, empresa_id } o null si no autenticado / sin empresa
 */
export async function getUserAndEmpresa(request?: Request | null): Promise<UsuarioConEmpresa | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey || !serviceKey) {
    return null;
  }

  let user: User | null = null;

  const bearer = request?.headers.get("authorization")?.replace(/^Bearer\s+/i, "")?.trim();
  if (bearer) {
    const jwtClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...supabaseDbSchemaOption,
    });
    const { data, error } = await jwtClient.auth.getUser(bearer);
    if (!error && data.user?.email) {
      user = data.user;
    }
  }

  if (!user?.email) {
    const cookieStore = await cookies();
    const supabaseAuth = createServerClient(url, anonKey, {
      ...supabaseDbSchemaOption,
      cookies: {
        getAll() {
          return cookieStore.getAll().map((c) => ({ name: c.name, value: c.value }));
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    });

    const {
      data: { user: cookieUser },
    } = await supabaseAuth.auth.getUser();
    user = cookieUser ?? null;
  }

  if (!user?.email) {
    return null;
  }

  const supabase = createClient(url, serviceKey, { ...supabaseServiceRoleClientOptions });

  const { data: usuario, error } = await supabase
    .from("usuarios")
    .select("empresa_id")
    .eq("email", user.email)
    .maybeSingle();

  if (error || !usuario?.empresa_id) {
    return null;
  }

  return {
    user,
    empresa_id: usuario.empresa_id,
  };
}
