import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createFlowEngine } from "@/lib/chat/flow-engine-service";
import {
  getFirstActiveNodeCodeForFlow,
  listActiveWhatsappFlowsForEmpresa,
} from "@/lib/chat/resolve-whatsapp-active-flow";
import { getAuthWithRol } from "@/lib/middleware/auth";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Endpoint temporal de prueba para disparar el nodo inicial del flujo.
 */
export async function POST(request: NextRequest) {
  try {
    const isTestMode = request.nextUrl.searchParams.get("test_mode") === "true";
    const allowTestMode =
      process.env.NODE_ENV !== "production" || process.env.ALLOW_TEST_MODE === "true";

    let empresaId: string | null = null;
    if (isTestMode) {
      if (!allowTestMode) {
        return NextResponse.json(
          { ok: false, error: "test_mode no permitido en este entorno" },
          { status: 403 }
        );
      }
      console.warn("[api/chat/flow/test-start] test_mode usado", {
        ip: request.headers.get("x-forwarded-for") ?? "unknown",
        ua: request.headers.get("user-agent") ?? "unknown",
      });
    } else {
      const auth = await getAuthWithRol();
      if (!auth?.empresa_id) {
        return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
      }
      empresaId = auth.empresa_id;
    }

    const body = (await request.json().catch(() => ({}))) as {
      conversation_id?: string;
      flow_code?: string;
      node_code?: string;
    };
    const conversationId = body.conversation_id?.trim();
    if (!conversationId) {
      return NextResponse.json(
        { ok: false, error: "Se requiere conversation_id" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();
    if (!empresaId) {
      const { data: convEmpresa, error: convEmpresaErr } = await supabase
        .from("chat_conversations")
        .select("empresa_id")
        .eq("id", conversationId)
        .maybeSingle();
      if (convEmpresaErr) {
        return NextResponse.json({ ok: false, error: convEmpresaErr.message }, { status: 400 });
      }
      if (!convEmpresa?.empresa_id) {
        return NextResponse.json(
          { ok: false, error: "Conversación no encontrada" },
          { status: 404 }
        );
      }
      empresaId = convEmpresa.empresa_id as string;
    }

    let flowCode = body.flow_code?.trim() ?? "";
    let nodeCode = body.node_code?.trim() ?? "";

    if (!flowCode) {
      const cat = await listActiveWhatsappFlowsForEmpresa(supabase, empresaId);
      if (cat.kind === "single") {
        flowCode = cat.flowCode;
      } else if (cat.kind === "none") {
        return NextResponse.json(
          { ok: false, error: "No hay flujos WhatsApp activos; activá uno o pasá flow_code en el body." },
          { status: 400 }
        );
      } else {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Hay varios flujos WhatsApp activos; indicá flow_code explícito en el body para test-start.",
            active_flow_codes: cat.flowCodes,
          },
          { status: 400 }
        );
      }
    }

    if (!nodeCode) {
      nodeCode =
        (await getFirstActiveNodeCodeForFlow(supabase, empresaId, flowCode)) || "inicio";
    }

    const { data: updated, error: upErr } = await supabase
      .from("chat_conversations")
      .update({
        flow_code: flowCode,
        flow_current_node: nodeCode,
        flow_status: "bot",
        human_taken_over: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId)
      .eq("empresa_id", empresaId)
      .select("id, flow_code, flow_current_node, flow_status, human_taken_over")
      .maybeSingle();

    if (upErr) {
      return NextResponse.json({ ok: false, error: upErr.message }, { status: 400 });
    }
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "Conversación no encontrada" },
        { status: 404 }
      );
    }

    const engine = createFlowEngine({ supabase });
    const sent = await engine.sendCurrentFlowNode({ conversationId });
    if (!sent.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: sent.error,
          conversation_id: conversationId,
          flow_code: flowCode,
          node_code: nodeCode,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      conversation_id: updated.id,
      flow_code: updated.flow_code,
      node_code: sent.nodeCode ?? updated.flow_current_node ?? nodeCode,
      flow_current_node: updated.flow_current_node,
      flow_status: updated.flow_status,
      human_taken_over: updated.human_taken_over,
      message_sent: true,
    });
  } catch (e) {
    console.error("[api/chat/flow/test-start]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
