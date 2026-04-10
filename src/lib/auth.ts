import { clearBrowserEmpresaDataSchemaCache } from "@/lib/supabase/browser-data-client";
import { supabase } from "./supabase";

/** Fila mínima de zentra_erp.usuarios usada en el cliente. */
export type CurrentUsuario = {
  id: string;
  empresa_id: string | null;
  email?: string | null;
  nombre?: string | null;
  rol?: string | null;
  estado?: string | null;
  telefono?: string | null;
  fecha_nacimiento?: string | null;
  auth_user_id?: string | null;
  created_at?: string | null;
};

export async function signIn(email: string, password: string) {
  clearBrowserEmpresaDataSchemaCache();
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  clearBrowserEmpresaDataSchemaCache();
  return supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function createUser(email: string, password: string) {
  const res = await fetch("/api/create-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : json.error?.message || "Error creando usuario"
    );
  }

  return json.user;
}

export async function getCurrentUser(): Promise<CurrentUsuario | null> {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: rows, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("email", user.email)
    .limit(1);

  if (error) throw error;

  const row = rows?.[0] as CurrentUsuario | undefined;
  return row ?? null;
}
