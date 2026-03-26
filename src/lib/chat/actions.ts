import { getEmpresaId } from "@/lib/db/empresa";
import { supabase } from "@/lib/supabase";

export type InboxConversation = {
  id: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  contact: {
    id: string;
    name: string | null;
    phone_number: string;
    cliente_id: string | null;
    crm_prospecto_id: string | null;
  };
};

export async function fetchChatConversations(): Promise<InboxConversation[]> {
  const { data: convs, error } = await supabase
    .from("chat_conversations")
    .select(
      `
      id,
      status,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id
    `
    )
    .order("last_message_at", { ascending: false });

  if (error) throw new Error(error.message);
  const list = convs ?? [];
  if (list.length === 0) return [];

  const contactIds = [...new Set(list.map((c) => c.contact_id as string))];
  const { data: contacts, error: e2 } = await supabase
    .from("chat_contacts")
    .select("id, name, phone_number, cliente_id, crm_prospecto_id")
    .in("id", contactIds);

  if (e2) throw new Error(e2.message);
  const byId = Object.fromEntries((contacts ?? []).map((c) => [c.id, c]));

  return list.map((row) => {
    const c = byId[row.contact_id as string];
    return {
      id: row.id as string,
      status: row.status as string,
      last_message_at: row.last_message_at as string | null,
      last_message_preview: row.last_message_preview as string | null,
      unread_count: (row.unread_count as number) ?? 0,
      contact: {
        id: c?.id ?? (row.contact_id as string),
        name: c?.name ?? null,
        phone_number: c?.phone_number ?? "",
        cliente_id: c?.cliente_id ?? null,
        crm_prospecto_id: c?.crm_prospecto_id ?? null,
      },
    };
  });
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { error } = await supabase
    .from("chat_conversations")
    .update({ unread_count: 0, updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  if (error) throw new Error(error.message);
}

export type ChatChannelRow = {
  id: string;
  empresa_id: string;
  type: string;
  meta_phone_number_id: string;
  nombre: string | null;
  provider: string;
  provider_channel_id: string | null;
  activo: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
};

export async function fetchChatChannels(): Promise<ChatChannelRow[]> {
  const { data, error } = await supabase
    .from("chat_channels")
    .select(
      "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config, created_at, updated_at"
    )
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    empresa_id: r.empresa_id as string,
    type: (r.type as string) ?? "whatsapp",
    meta_phone_number_id: (r.meta_phone_number_id as string) ?? "",
    nombre: (r.nombre as string) ?? null,
    provider: (r.provider as string) ?? "meta",
    provider_channel_id: (r.provider_channel_id as string) ?? null,
    activo: r.activo !== false,
    config: (typeof r.config === "object" && r.config !== null ? r.config : {}) as Record<string, unknown>,
    created_at: (r.created_at as string) ?? "",
    updated_at: r.updated_at as string | undefined,
  }));
}

export type ChatChannelFormInput = {
  id?: string;
  nombre: string;
  meta_phone_number_id: string;
  provider_channel_id: string;
  activo: boolean;
  display_phone_number?: string;
  /** Token Meta para enviar desde el ERP; en edición, vacío = no cambiar el guardado */
  whatsapp_access_token?: string;
};

export async function saveChatChannel(input: ChatChannelFormInput): Promise<void> {
  const empresa_id = await getEmpresaId();
  const pid = input.meta_phone_number_id.trim();
  if (!pid) throw new Error("Phone Number ID es obligatorio");

  const config: Record<string, unknown> = {
    phone_number_id: pid,
  };
  const disp = input.display_phone_number?.trim();
  if (disp) config.display_phone_number = disp;

  const base = {
    nombre: input.nombre.trim() || "WhatsApp",
    type: "whatsapp" as const,
    meta_phone_number_id: pid,
    provider: "meta",
    provider_channel_id: input.provider_channel_id.trim() || pid,
    activo: input.activo,
    config,
  };

  const tokenPatch = input.whatsapp_access_token?.trim();

  if (input.id) {
    const updatePayload: Record<string, unknown> = {
      ...base,
      updated_at: new Date().toISOString(),
    };
    if (tokenPatch) {
      updatePayload.whatsapp_access_token = tokenPatch;
    }
    const { error } = await supabase
      .from("chat_channels")
      .update(updatePayload)
      .eq("id", input.id)
      .eq("empresa_id", empresa_id);

    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase.from("chat_channels").insert({
    empresa_id,
    ...base,
    whatsapp_access_token: tokenPatch || null,
  });

  if (error) throw new Error(error.message);
}

export async function deleteChatChannel(id: string): Promise<void> {
  const empresa_id = await getEmpresaId();
  const { error } = await supabase.from("chat_channels").delete().eq("id", id).eq("empresa_id", empresa_id);
  if (error) throw new Error(error.message);
}
