import { createServerClient } from "@supabase/ssr";
import { supabaseDbSchemaOption, supabaseServiceRoleClientOptions } from "@/lib/supabase/schema";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/** Lista usuarios de la empresa del usuario autenticado (para /usuarios) */
export async function GET() {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !anonKey || !serviceKey) {
      return NextResponse.json({ error: "Config no disponible" }, { status: 500 });
    }

    const cookieStore = await cookies();
    const supabaseAuth = createServerClient(url, anonKey, {
      ...supabaseDbSchemaOption,
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (c) => c.forEach(({ name, value, options }) => cookieStore.set(name, value, options)),
      },
    });
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user?.email) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const supabase = createClient(url, serviceKey, { ...supabaseServiceRoleClientOptions });

    const { data: curRows } = await supabase
      .from("usuarios")
      .select("empresa_id, rol")
      .eq("email", user.email)
      .limit(1);

    const currentUser = curRows?.[0] as { empresa_id?: string; rol?: string } | undefined;
    const empresaId = currentUser?.empresa_id;
    if (!empresaId && currentUser?.rol !== "super_admin") {
      return NextResponse.json({ usuarios: [] });
    }

    let query = supabase
      .from("usuarios")
      .select("id, nombre, email, telefono, fecha_nacimiento, rol, estado, created_at")
      .order("created_at", { ascending: false });

    if (currentUser?.rol !== "super_admin") {
      query = query.eq("empresa_id", empresaId);
    }

    const { data: usuarios, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ usuarios: usuarios ?? [] });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
