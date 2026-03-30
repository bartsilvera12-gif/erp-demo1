import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return NextResponse.json({ error: "Config no disponible" }, { status: 500 });
    }

    const supabase = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1. Empresa
    const { data: empresa, error: errEmpresa } = await supabase
      .from("empresas")
      .select("*")
      .eq("id", id)
      .single();

    if (errEmpresa || !empresa) {
      return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
    }

    // 2. Usuarios de la empresa (incluye estado y módulos si existe)
    const { data: usuariosRaw } = await supabase
      .from("usuarios")
      .select("id, nombre, email, rol, estado, created_at")
      .eq("empresa_id", id)
      .order("created_at", { ascending: false });

    const usuarios = usuariosRaw ?? [];
    const userIds = usuarios.map((u) => u.id);

    let usuarioModulosMap: Record<string, string[]> = {};
    if (userIds.length > 0) {
      const { data: umData } = await supabase
        .from("usuario_modulos")
        .select("usuario_id, modulo_id")
        .in("usuario_id", userIds);
      if (umData) {
        for (const row of umData) {
          const uid = (row as { usuario_id: string }).usuario_id;
          const mid = (row as { modulo_id: string }).modulo_id;
          if (!usuarioModulosMap[uid]) usuarioModulosMap[uid] = [];
          usuarioModulosMap[uid].push(mid);
        }
      }
    }

    const usuariosConModulos = usuarios.map((u) => ({
      ...u,
      modulo_ids: usuarioModulosMap[u.id] ?? [],
    }));

    // 3. Módulos habilitados (empresa_modulos + modulos)
    const { data: emData } = await supabase
      .from("empresa_modulos")
      .select("modulo_id")
      .eq("empresa_id", id)
      .eq("activo", true);

    const moduloIds = (emData ?? []).map((r) => r.modulo_id).filter(Boolean);
    let modulos: { id: string; nombre: string; slug: string }[] = [];

    if (moduloIds.length > 0) {
      const { data: mod } = await supabase
        .from("modulos")
        .select("id, nombre, slug")
        .in("id", moduloIds);
      modulos = (mod ?? []).map((m) => ({
        id: m.id,
        nombre: (m.nombre ?? m.id) as string,
        slug: (m.slug ?? "") as string,
      }));
    }

    return NextResponse.json({
      empresa,
      usuarios: usuariosConModulos,
      modulos,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { nombre_empresa, ruc, plan, estado, modulo_ids } = body;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return NextResponse.json({ error: "Config no disponible" }, { status: 500 });
    }

    const supabase = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1. Actualizar empresa
    const updateEmpresa: Record<string, unknown> = {};
    if (nombre_empresa !== undefined) updateEmpresa.nombre_empresa = nombre_empresa;
    if (ruc !== undefined) updateEmpresa.ruc = ruc;
    if (plan !== undefined) updateEmpresa.plan = plan;
    if (estado !== undefined) updateEmpresa.estado = estado;

    if (Object.keys(updateEmpresa).length > 0) {
      const { error: errUpdate } = await supabase
        .from("empresas")
        .update(updateEmpresa)
        .eq("id", id);

      if (errUpdate) {
        return NextResponse.json({ error: errUpdate.message }, { status: 400 });
      }
    }

    // 2. Actualizar módulos habilitados
    if (Array.isArray(modulo_ids)) {
      await supabase.from("empresa_modulos").delete().eq("empresa_id", id);

      if (modulo_ids.length > 0) {
        const rows = modulo_ids.map((modulo_id: string) => ({
          empresa_id: id,
          modulo_id,
          activo: true,
        }));
        const { error: errMod } = await supabase.from("empresa_modulos").insert(rows);
        if (errMod) {
          return NextResponse.json(
            { error: `Empresa actualizada pero error en módulos: ${errMod.message}` },
            { status: 400 }
          );
        }
      }

      const allowed = new Set(modulo_ids);
      const { data: userRows } = await supabase.from("usuarios").select("id").eq("empresa_id", id);
      const uids = (userRows ?? []).map((r) => r.id as string);
      if (uids.length > 0) {
        const { data: ums } = await supabase
          .from("usuario_modulos")
          .select("id, modulo_id")
          .in("usuario_id", uids);
        for (const row of ums ?? []) {
          if (!allowed.has(row.modulo_id as string)) {
            await supabase.from("usuario_modulos").delete().eq("id", row.id as string);
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
