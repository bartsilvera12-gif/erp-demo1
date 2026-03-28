import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ flowCode: string }> }
) {
  try {
    const auth = await getAuthWithRol();
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const params = await context.params;
    const flowCode = params.flowCode;
    const body = (await request.json().catch(() => ({}))) as {
      label?: string;
      channel?: string;
      activo?: boolean;
      /** UUID del sorteo: al enviar comprobante por WhatsApp se crea orden + cupones (si el módulo está activo). */
      sorteo_id?: string | null;
    };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.label === "string") patch.label = body.label.trim();
    if (typeof body.channel === "string") patch.channel = body.channel.trim() || "whatsapp";
    if (typeof body.activo === "boolean") patch.activo = body.activo;
    const supabase = getSupabaseAdmin();

    if ("sorteo_id" in body) {
      if (body.sorteo_id === null || body.sorteo_id === "") {
        patch.sorteo_id = null;
      } else if (typeof body.sorteo_id === "string") {
        const sid = body.sorteo_id.trim();
        const { data: sorteoOk, error: se } = await supabase
          .from("sorteos")
          .select("id")
          .eq("empresa_id", auth.empresa_id)
          .eq("id", sid)
          .maybeSingle();
        if (se || !sorteoOk) {
          return NextResponse.json(
            { ok: false, error: "sorteo_id inválido o no pertenece a la empresa" },
            { status: 400 }
          );
        }
        patch.sorteo_id = sid;
      }
    }
    const { data, error } = await supabase
      .from("chat_flows")
      .update(patch)
      .eq("empresa_id", auth.empresa_id)
      .eq("flow_code", flowCode)
      .select("flow_code, label, channel, activo, sorteo_id, updated_at")
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    if (!data) return NextResponse.json({ ok: false, error: "Flow no encontrado" }, { status: 404 });
    return NextResponse.json({ ok: true, item: data });
  } catch (e) {
    console.error("[api/chat/flows/:flowCode][PATCH]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
