import {
  provisionChannelFromWebhookEnv,
  type WebhookProvisionEnv,
} from "@/lib/chat/channel-provision";
import type {
  MetaInboundMessage,
  MetaWebhookValue,
  ProcessWebhookResult,
  SupabaseAdmin,
} from "@/lib/chat/types";

/** Solo dígitos, sin prefijo + */
export function normalizeWaPhone(waId: string): string {
  return waId.replace(/\D/g, "");
}

function contactNameForWa(
  contacts: MetaWebhookValue["contacts"],
  waId: string
): string | null {
  if (!contacts?.length) return null;
  const norm = normalizeWaPhone(waId);
  const c = contacts.find((x) => x.wa_id && normalizeWaPhone(x.wa_id) === norm);
  return c?.profile?.name?.trim() || null;
}

export function extractMessageBody(msg: MetaInboundMessage): { message_type: string; content: string } {
  const t = msg.type ?? "unknown";
  switch (t) {
    case "text":
      return { message_type: "text", content: msg.text?.body ?? "" };
    case "image":
      return {
        message_type: "image",
        content: msg.image?.caption?.trim() || "[imagen]",
      };
    case "document":
      return {
        message_type: "document",
        content:
          msg.document?.caption?.trim() ||
          msg.document?.filename ||
          "[documento]",
      };
    case "audio":
      return { message_type: "audio", content: "[audio]" };
    case "video":
      return {
        message_type: "video",
        content: msg.video?.caption?.trim() || "[video]",
      };
    case "sticker":
      return { message_type: "sticker", content: "[sticker]" };
    default:
      return { message_type: t, content: `[${t}]` };
  }
}

async function messageExists(
  supabase: SupabaseAdmin,
  waMessageId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  return !!data?.id;
}

/**
 * Procesa mensajes entrantes de un único `value` de Meta (un change).
 */
export async function processInboundWebhookValue(
  supabase: SupabaseAdmin,
  value: MetaWebhookValue,
  provisionEnv?: WebhookProvisionEnv
): Promise<ProcessWebhookResult> {
  const errors: string[] = [];
  let processed = 0;
  let skipped = 0;

  const phoneNumberId = value.metadata?.phone_number_id?.trim();
  if (!phoneNumberId) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: ["Falta metadata.phone_number_id"],
    };
  }

  const { data: ch0, error: chErr } = await supabase
    .from("chat_channels")
    .select("id, empresa_id, meta_phone_number_id, activo")
    .eq("meta_phone_number_id", phoneNumberId)
    .maybeSingle();

  if (chErr) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: [chErr.message],
    };
  }

  let channel = ch0 as
    | { id: string; empresa_id: string; meta_phone_number_id: string; activo: boolean | null }
    | null;

  if (channel && channel.activo === false) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: [
        "El canal WhatsApp está desactivado. Activalo en Conversaciones → Configuración.",
      ],
    };
  }

  if (!channel && provisionEnv) {
    await provisionChannelFromWebhookEnv(supabase, phoneNumberId, provisionEnv);
    const { data: ch1 } = await supabase
      .from("chat_channels")
      .select("id, empresa_id, meta_phone_number_id, activo")
      .eq("meta_phone_number_id", phoneNumberId)
      .maybeSingle();
    channel = ch1 as typeof channel;
  }

  if (!channel) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: [
        `Canal no registrado para phone_number_id=${phoneNumberId}. Configurá el canal en el ERP (Conversaciones → Configuración) o definí WHATSAPP_DEFAULT_EMPRESA_ID y WHATSAPP_PHONE_NUMBER_ID (mismo ID que en Meta) en el servidor.`,
      ],
    };
  }

  const empresaId = channel.empresa_id as string;
  const channelId = channel.id as string;
  const messages = value.messages ?? [];

  for (const msg of messages) {
    const from = msg.from ? normalizeWaPhone(msg.from) : "";
    const waMid = msg.id?.trim();
    if (!from || !waMid) {
      skipped += 1;
      errors.push("Mensaje sin from o id");
      continue;
    }

    if (await messageExists(supabase, waMid)) {
      skipped += 1;
      continue;
    }

    const displayName = contactNameForWa(value.contacts, from) ?? from;

    try {
      const { data: contact, error: cErr } = await supabase
        .from("chat_contacts")
        .upsert(
          {
            empresa_id: empresaId,
            phone_number: from,
            name: displayName,
          },
          { onConflict: "empresa_id,phone_number" }
        )
        .select("id, name")
        .single();

      if (cErr || !contact) {
        errors.push(`Contacto: ${cErr?.message ?? "error"}`);
        continue;
      }

      const contactId = contact.id as string;
      if (displayName && displayName !== contact.name) {
        await supabase
          .from("chat_contacts")
          .update({ name: displayName, updated_at: new Date().toISOString() })
          .eq("id", contactId);
      }

      let { data: existingConv } = await supabase
        .from("chat_conversations")
        .select("id, status, unread_count")
        .eq("contact_id", contactId)
        .eq("channel_id", channelId)
        .maybeSingle();

      const { message_type, content } = extractMessageBody(msg);
      const preview = content.slice(0, 280);
      const ts = msg.timestamp
        ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
        : new Date().toISOString();

      if (!existingConv) {
        const { data: conv, error: convErr } = await supabase
          .from("chat_conversations")
          .insert({
            empresa_id: empresaId,
            channel_id: channelId,
            contact_id: contactId,
            status: "nuevo",
            last_message_at: null,
            last_message_preview: null,
            unread_count: 0,
          })
          .select("id, status, unread_count")
          .single();

        if (conv) {
          existingConv = conv;
        } else if (convErr?.code === "23505") {
          const { data: again } = await supabase
            .from("chat_conversations")
            .select("id, status, unread_count")
            .eq("contact_id", contactId)
            .eq("channel_id", channelId)
            .maybeSingle();
          if (again) existingConv = again;
        } else if (convErr) {
          errors.push(`Conversación: ${convErr.message}`);
          continue;
        }
      }

      if (!existingConv) {
        errors.push("Conversación: no encontrada");
        continue;
      }

      const conversationId = existingConv.id as string;

      const { error: insErr } = await supabase.from("chat_messages").insert({
        empresa_id: empresaId,
        conversation_id: conversationId,
        wa_message_id: waMid,
        from_me: false,
        message_type,
        content,
        raw_payload: msg as unknown as Record<string, unknown>,
      });

      if (insErr) {
        if (insErr.code === "23505") {
          skipped += 1;
          continue;
        }
        errors.push(`Insert mensaje: ${insErr.message}`);
        continue;
      }

      const prevStatus = existingConv.status as string;
      const nextStatus = prevStatus === "cerrado" ? "pendiente" : prevStatus;

      await supabase
        .from("chat_conversations")
        .update({
          last_message_at: ts,
          last_message_preview: preview,
          unread_count: (existingConv.unread_count as number) + 1,
          status: nextStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversationId);

      processed += 1;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    ok: errors.length === 0 || processed > 0,
    processed,
    skipped,
    errors,
  };
}

/**
 * Recorre el body completo del webhook Meta.
 */
export async function processWhatsAppWebhookBody(
  supabase: SupabaseAdmin,
  body: unknown,
  provisionEnv?: WebhookProvisionEnv
): Promise<ProcessWebhookResult> {
  const aggregated: ProcessWebhookResult = {
    ok: true,
    processed: 0,
    skipped: 0,
    errors: [],
  };

  if (!body || typeof body !== "object") {
    aggregated.ok = false;
    aggregated.errors.push("Body inválido");
    return aggregated;
  }

  const root = body as { entry?: Array<{ changes?: unknown[] }> };
  const entries = root.entry ?? [];

  for (const ent of entries) {
    const changes = ent.changes ?? [];
    for (const ch of changes) {
      const change = ch as { value?: MetaWebhookValue; field?: string };
      if (change.field === "statuses") continue;
      const value = change.value;
      if (!value?.messages?.length) continue;

      const r = await processInboundWebhookValue(supabase, value, provisionEnv);
      aggregated.processed += r.processed;
      aggregated.skipped += r.skipped;
      aggregated.errors.push(...r.errors);
      if (!r.ok) aggregated.ok = false;
    }
  }

  return aggregated;
}
