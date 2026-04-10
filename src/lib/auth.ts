import { clearBrowserEmpresaDataSchemaCache } from "@/lib/supabase/browser-data-client";
import { supabase } from "./supabase";

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

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("email", user.email)
    .maybeSingle();

  if (error) throw error;

  return data ?? null;
}
