import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import type { WebhookProvisionEnv } from "@/lib/chat/channel-provision";
import { verifyMetaSignature } from "@/lib/chat/meta-signature";
import { processWhatsAppWebhookBody } from "@/lib/chat/whatsapp-webhook-service";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * GET — verificación del webhook Meta (hub.challenge)
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verify = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && verify && token === verify && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

/**
 * POST — eventos entrantes (mensajes, estados, etc.)
 * No valida empresa_modulos: el canal (chat_channels) define la empresa; los mensajes se guardan siempre.
 * Aprovisionamiento automático (demo): WHATSAPP_DEFAULT_EMPRESA_ID + WHATSAPP_PHONE_NUMBER_ID (debe coincidir con el webhook).
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (appSecret) {
      const sig = request.headers.get("x-hub-signature-256");
      if (!verifyMetaSignature(rawBody, sig, appSecret)) {
        return NextResponse.json({ ok: false, error: "Firma inválida" }, { status: 401 });
      }
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const provisionEnv: WebhookProvisionEnv = {
      defaultEmpresaId: process.env.WHATSAPP_DEFAULT_EMPRESA_ID?.trim(),
      expectedPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim(),
    };
    const result = await processWhatsAppWebhookBody(supabase, body, provisionEnv);

    return NextResponse.json({
      ok: result.ok,
      processed: result.processed,
      skipped: result.skipped,
      errors: result.errors,
    });
  } catch (e) {
    console.error("[webhooks/whatsapp]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
