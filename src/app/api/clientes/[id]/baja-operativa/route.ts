import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthWithRol, isAdmin } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * GET /api/clientes/:id/baja-operativa
 * Obtiene info previa: suscripciones activas, factura pendiente del mes.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthWithRol();
    if (!auth) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    const { id: clienteId } = await params;
    if (!clienteId) {
      return NextResponse.json(errorResponse("id es obligatorio"), { status: 400 });
    }

    const supabase = getSupabase();

    const { data: cliente } = await supabase
      .from("clientes")
      .select("id, empresa_id, estado, baja_operativa_at")
      .eq("id", clienteId)
      .eq("empresa_id", auth.empresa_id)
      .is("deleted_at", null)
      .single();

    if (!cliente) {
      return NextResponse.json(errorResponse("Cliente no encontrado"), { status: 404 });
    }

    if (cliente.estado === "inactivo") {
      return NextResponse.json(errorResponse("El cliente ya está dado de baja"), { status: 400 });
    }

    const now = new Date();
    const anio = now.getFullYear();
    const mes = now.getMonth() + 1;
    const inicioMes = `${anio}-${String(mes).padStart(2, "0")}-01`;
    const finMes = `${anio}-${String(mes).padStart(2, "0")}-31`;

    const [suscRes, factRes] = await Promise.all([
      supabase
        .from("suscripciones")
        .select("id, precio, moneda")
        .eq("cliente_id", clienteId)
        .eq("estado", "activa"),
      supabase
        .from("facturas")
        .select("id, numero_factura, monto, saldo, fecha, estado")
        .eq("cliente_id", clienteId)
        .neq("estado", "Anulado")
        .gt("saldo", 0)
        .gte("fecha", inicioMes)
        .lte("fecha", finMes),
    ]);

    const suscripcionesActivas = suscRes.data ?? [];
    const facturasPendientesMes = factRes.data ?? [];

    return NextResponse.json(successResponse({
      suscripciones_activas: suscripcionesActivas.length,
      factura_pendiente_mes: facturasPendientesMes.length > 0
        ? { id: facturasPendientesMes[0].id, numero_factura: facturasPendientesMes[0].numero_factura, monto: facturasPendientesMes[0].monto }
        : null,
      suscripciones: suscripcionesActivas,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

/**
 * POST /api/clientes/:id/baja-operativa
 * Da de baja operativa al cliente: estado inactivo, cancela suscripciones,
 * opcionalmente anula factura pendiente del mes.
 * Body: { motivo: string, anular_factura_pendiente?: boolean }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthWithRol();
    if (!auth) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    if (!isAdmin(auth)) {
      return NextResponse.json(errorResponse("Solo usuarios administradores pueden dar de baja clientes"), { status: 403 });
    }

    const { id: clienteId } = await params;
    if (!clienteId) {
      return NextResponse.json(errorResponse("id es obligatorio"), { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
    const anularFacturaPendiente = Boolean(body.anular_factura_pendiente);

    if (!motivo) {
      return NextResponse.json(errorResponse("El motivo es obligatorio"), { status: 400 });
    }

    const supabase = getSupabase();

    const { data: cliente } = await supabase
      .from("clientes")
      .select("id, empresa_id, estado")
      .eq("id", clienteId)
      .eq("empresa_id", auth.empresa_id)
      .is("deleted_at", null)
      .single();

    if (!cliente) {
      return NextResponse.json(errorResponse("Cliente no encontrado"), { status: 404 });
    }

    if (cliente.estado === "inactivo") {
      return NextResponse.json(errorResponse("El cliente ya está dado de baja"), { status: 400 });
    }

    const now = new Date().toISOString();
    const anio = new Date().getFullYear();
    const mes = new Date().getMonth() + 1;
    const inicioMes = `${anio}-${String(mes).padStart(2, "0")}-01`;
    const finMes = `${anio}-${String(mes).padStart(2, "0")}-31`;

    if (anularFacturaPendiente) {
      const { data: facturas } = await supabase
        .from("facturas")
        .select("id")
        .eq("cliente_id", clienteId)
        .neq("estado", "Anulado")
        .gt("saldo", 0)
        .gte("fecha", inicioMes)
        .lte("fecha", finMes);

      for (const f of facturas ?? []) {
        await supabase
          .from("facturas")
          .update({ estado: "Anulado", saldo: 0, updated_at: now })
          .eq("id", f.id);
      }
    }

    const { error: errSusc } = await supabase
      .from("suscripciones")
      .update({ estado: "cancelada" })
      .eq("cliente_id", clienteId)
      .eq("estado", "activa");

    if (errSusc) {
      return NextResponse.json(errorResponse("Error al cancelar suscripciones: " + errSusc.message), { status: 500 });
    }

    const { error: errCliente } = await supabase
      .from("clientes")
      .update({
        estado:                  "inactivo",
        baja_operativa_at:       now,
        baja_operativa_by_user_id: auth.user.id,
        baja_operativa_motivo:   motivo,
        baja_operativa_anulo_factura: anularFacturaPendiente,
        updated_at:              now,
      })
      .eq("id", clienteId);

    if (errCliente) {
      return NextResponse.json(errorResponse("Error al actualizar cliente: " + errCliente.message), { status: 500 });
    }

    return NextResponse.json(successResponse({
      baja: true,
      suscripciones_canceladas: true,
      factura_anulada: anularFacturaPendiente,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
