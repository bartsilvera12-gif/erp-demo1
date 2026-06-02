import { NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { errorResponse, successResponse } from "@/lib/api/response";
import { requireProyectosApiAccess } from "@/lib/proyectos/proyectos-auth";

export async function GET(request: Request) {
  const auth = await requireProyectosApiAccess(request);
  if (!auth.ok) {
    return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  }

  try {
    const sb = await getChatServiceClientForEmpresa(auth.empresaId);
    const emp = auth.empresaId;
    const now = new Date();
    const nowIso = now.toISOString();
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const twoDays = new Date(now.getTime() + 2 * 86400000).toISOString();

    // Builder base reutilizable (count exacto sin traer filas) para proyectos no archivados.
    const baseCount = () =>
      sb
        .from("proyectos")
        .select("id", { count: "exact", head: true })
        .eq("empresa_id", emp)
        .eq("archivado", false);

    // ── Fase 1: todo lo que no depende de otros resultados, en paralelo ──────────
    const [estCliente, estFinal, allEstadosRes, activos, vencidos, porVencer, prSampleRes] =
      await Promise.all([
        sb.from("proyecto_estados").select("id").eq("empresa_id", emp).eq("activo", true).eq("tipo_sla", "cliente"),
        sb.from("proyecto_estados").select("id").eq("empresa_id", emp).eq("activo", true).eq("es_estado_final", true),
        sb.from("proyecto_estados").select("id, nombre, codigo, color, sort_order").eq("empresa_id", emp).eq("activo", true).order("sort_order", { ascending: true }),
        baseCount(),
        baseCount().not("fecha_prometida", "is", null).lt("fecha_prometida", nowIso),
        baseCount().not("fecha_prometida", "is", null).gte("fecha_prometida", nowIso).lte("fecha_prometida", twoDays),
        sb.from("proyectos").select("responsable_comercial_id, responsable_tecnico_id").eq("empresa_id", emp).eq("archivado", false).limit(5000),
      ]);

    if (allEstadosRes.error) {
      return NextResponse.json(errorResponse(allEstadosRes.error.message), { status: 400 });
    }

    const clienteEstadoIds = (estCliente.data ?? []).map((r: { id: string }) => r.id);
    const finalEstadoIds = (estFinal.data ?? []).map((r: { id: string }) => r.id);
    const allEstados = (allEstadosRes.data ?? []) as { id: string; nombre: string; codigo: string; color: string }[];

    // ── Fase 2: dependientes (necesitan estados/all), también en paralelo ────────
    const zeroCount = Promise.resolve({ count: 0 as number | null });
    const emptyData = Promise.resolve({ data: [] as { fecha_ingreso: string; fecha_entrega: string | null; updated_at: string | null }[] });

    const [esperandoCliente, entregadosMes, hechosRes, ...porEstadoCounts] = await Promise.all([
      clienteEstadoIds.length > 0 ? baseCount().in("estado_id", clienteEstadoIds) : zeroCount,
      finalEstadoIds.length > 0 ? baseCount().in("estado_id", finalEstadoIds).gte("updated_at", startMonth) : zeroCount,
      finalEstadoIds.length > 0
        ? sb.from("proyectos").select("fecha_ingreso, fecha_entrega, updated_at").eq("empresa_id", emp).in("estado_id", finalEstadoIds).not("fecha_ingreso", "is", null).limit(500)
        : emptyData,
      ...allEstados.map((e) => baseCount().eq("estado_id", e.id)),
    ]);

    const por_estado = allEstados.map((row, i) => ({
      estado_id: row.id,
      nombre: row.nombre,
      codigo: row.codigo,
      color: row.color,
      cantidad: (porEstadoCounts[i] as { count: number | null })?.count ?? 0,
    }));

    // ── Agregaciones en memoria (sin queries extra) ─────────────────────────────
    const por_responsable: { usuario_id: string; rol: "comercial" | "tecnico"; cantidad: number }[] = [];
    const mapCom = new Map<string, number>();
    const mapTec = new Map<string, number>();
    for (const p of prSampleRes.data ?? []) {
      const r = p as { responsable_comercial_id?: string | null; responsable_tecnico_id?: string | null };
      if (r.responsable_comercial_id) mapCom.set(r.responsable_comercial_id, (mapCom.get(r.responsable_comercial_id) ?? 0) + 1);
      if (r.responsable_tecnico_id) mapTec.set(r.responsable_tecnico_id, (mapTec.get(r.responsable_tecnico_id) ?? 0) + 1);
    }
    for (const [uid, n] of mapCom) por_responsable.push({ usuario_id: uid, rol: "comercial", cantidad: n });
    for (const [uid, n] of mapTec) por_responsable.push({ usuario_id: uid, rol: "tecnico", cantidad: n });

    let tiempo_promedio_produccion_dias: number | null = null;
    const hechos = (hechosRes as { data: { fecha_ingreso: string; fecha_entrega: string | null; updated_at: string | null }[] }).data ?? [];
    if (hechos.length > 0) {
      const dias: number[] = [];
      for (const r of hechos) {
        const fin = r.fecha_entrega ? Date.parse(r.fecha_entrega) : Date.parse(r.updated_at ?? "");
        const ini = Date.parse(r.fecha_ingreso);
        if (Number.isFinite(fin) && Number.isFinite(ini) && fin >= ini) dias.push((fin - ini) / 86400000);
      }
      if (dias.length > 0) {
        tiempo_promedio_produccion_dias = Math.round((dias.reduce((a, b) => a + b, 0) / dias.length) * 10) / 10;
      }
    }

    return NextResponse.json(
      successResponse({
        activos: activos.count ?? 0,
        vencidos: vencidos.count ?? 0,
        por_vencer: porVencer.count ?? 0,
        esperando_cliente: esperandoCliente.count ?? 0,
        entregados_este_mes: entregadosMes.count ?? 0,
        tiempo_promedio_produccion_dias,
        por_estado,
        por_responsable,
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
