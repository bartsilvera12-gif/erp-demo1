import type { AppSupabaseClient } from "@/lib/supabase/schema";

const DISTRIBUTION = new Set(["round_robin", "least_load", "manual_pull"]);

/** Misma forma que `ChatChannelRow` en `actions.ts` (evita importar módulo `use server` desde el repo). */
export type QueueEditorChatChannelRow = {
  id: string;
  empresa_id: string;
  type: string;
  meta_phone_number_id: string | null;
  nombre: string | null;
  provider: string;
  provider_channel_id: string | null;
  activo: boolean;
  connection_mode: string | null;
  config_status: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
};

export type QueueAdminTenantContext = {
  supabase: AppSupabaseClient;
  catalogSr: AppSupabaseClient;
  empresa_id: string;
};

export type ChatQueueAdminRow = {
  id: string;
  nombre: string;
  descripcion: string | null;
  is_active: boolean;
  channel_type: string | null;
  distribution_strategy: string;
  priority: number;
};

export type QueueChannelLink = {
  channel_id: string;
  channel_nombre: string | null;
  channel_type: string;
};

export type QueueAgentRow = {
  id: string;
  usuario_id: string;
  nombre: string;
  email: string;
  is_online: boolean;
  max_conversations: number;
  is_active: boolean;
  receives_new_chats: boolean;
  priority_in_queue: number;
};

export type UsuarioPickRow = { id: string; nombre: string; email: string };

function mapChatChannelRow(r: Record<string, unknown>): QueueEditorChatChannelRow {
  const mp = r.meta_phone_number_id;
  return {
    id: r.id as string,
    empresa_id: r.empresa_id as string,
    type: (r.type as string) ?? "whatsapp",
    meta_phone_number_id: typeof mp === "string" ? mp : mp != null ? String(mp) : null,
    nombre: (r.nombre as string) ?? null,
    provider: (r.provider as string) ?? "meta",
    provider_channel_id: (r.provider_channel_id as string) ?? null,
    activo: r.activo !== false,
    connection_mode: (r.connection_mode as string | null) ?? null,
    config_status: (r.config_status as string) ?? "incomplete",
    config: (typeof r.config === "object" && r.config !== null ? r.config : {}) as Record<string, unknown>,
    created_at: (r.created_at as string) ?? "",
    updated_at: r.updated_at as string | undefined,
  };
}

export async function repoListQueues(ctx: QueueAdminTenantContext): Promise<ChatQueueAdminRow[]> {
  const { data, error } = await ctx.supabase
    .from("chat_queues")
    .select("id, nombre, descripcion, is_active, channel_type, distribution_strategy, priority")
    .eq("empresa_id", ctx.empresa_id)
    .order("priority", { ascending: false })
    .order("nombre", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ChatQueueAdminRow[];
}

export async function repoFetchQueue(ctx: QueueAdminTenantContext, queueId: string): Promise<ChatQueueAdminRow | null> {
  const id = queueId.trim();
  if (!id) return null;
  const { data, error } = await ctx.supabase
    .from("chat_queues")
    .select("id, nombre, descripcion, is_active, channel_type, distribution_strategy, priority")
    .eq("id", id)
    .eq("empresa_id", ctx.empresa_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ChatQueueAdminRow) ?? null;
}

export async function repoCreateQueueDraft(ctx: QueueAdminTenantContext): Promise<string> {
  const { data, error } = await ctx.supabase
    .from("chat_queues")
    .insert({
      empresa_id: ctx.empresa_id,
      nombre: "Nueva cola",
      is_active: true,
      channel_type: null,
      descripcion: null,
      distribution_strategy: "least_load",
      priority: 0,
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const rid = data?.id as string | undefined;
  if (!rid) throw new Error("No se pudo crear la cola. Verificá migraciones omnicanal (chat_queues).");
  return rid;
}

export async function repoSaveQueue(
  ctx: QueueAdminTenantContext,
  input: {
    id: string;
    nombre: string;
    descripcion?: string | null;
    is_active: boolean;
    channel_type?: string | null;
    distribution_strategy: string;
    priority?: number;
  }
): Promise<void> {
  const ds = input.distribution_strategy.trim();
  if (!DISTRIBUTION.has(ds)) throw new Error("Estrategia de distribución inválida");
  const { error } = await ctx.supabase
    .from("chat_queues")
    .update({
      nombre: input.nombre.trim() || "Cola",
      descripcion: input.descripcion?.trim() || null,
      is_active: input.is_active,
      channel_type: input.channel_type?.trim() || null,
      distribution_strategy: ds,
      priority: input.priority ?? 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id.trim())
    .eq("empresa_id", ctx.empresa_id);
  if (error) throw new Error(error.message);
}

export async function repoDeleteQueue(ctx: QueueAdminTenantContext, queueId: string): Promise<void> {
  const { error } = await ctx.supabase
    .from("chat_queues")
    .delete()
    .eq("id", queueId.trim())
    .eq("empresa_id", ctx.empresa_id);
  if (error) throw new Error(error.message);
}

export async function repoListQueueChannelLinks(ctx: QueueAdminTenantContext, queueId: string): Promise<QueueChannelLink[]> {
  const qid = queueId.trim();
  const { data: links, error } = await ctx.supabase
    .from("chat_queue_channels")
    .select("channel_id")
    .eq("empresa_id", ctx.empresa_id)
    .eq("queue_id", qid);
  if (error) throw new Error(error.message);
  const ids = (links ?? []).map((r) => r.channel_id as string).filter(Boolean);
  if (ids.length === 0) return [];
  const { data: ch, error: chErr } = await ctx.supabase
    .from("chat_channels")
    .select("id, nombre, type")
    .eq("empresa_id", ctx.empresa_id)
    .in("id", ids);
  if (chErr) throw new Error(chErr.message);
  return (ch ?? []).map((r) => ({
    channel_id: r.id as string,
    channel_nombre: (r as { nombre?: string | null }).nombre ?? null,
    channel_type: ((r as { type?: string }).type as string) ?? "whatsapp",
  }));
}

export async function repoSetQueueChannelLinks(
  ctx: QueueAdminTenantContext,
  queueId: string,
  channelIds: string[]
): Promise<void> {
  const qid = queueId.trim();
  const uniq = [...new Set(channelIds.map((x) => x.trim()).filter(Boolean))];
  const { data: queue, error: qe } = await ctx.supabase
    .from("chat_queues")
    .select("id")
    .eq("id", qid)
    .eq("empresa_id", ctx.empresa_id)
    .maybeSingle();
  if (qe) throw new Error(qe.message);
  if (!queue) throw new Error("Cola no encontrada");

  const { error: delErr } = await ctx.supabase
    .from("chat_queue_channels")
    .delete()
    .eq("queue_id", qid)
    .eq("empresa_id", ctx.empresa_id);
  if (delErr) throw new Error(delErr.message);
  if (uniq.length === 0) return;

  const { data: channels, error: cErr } = await ctx.supabase
    .from("chat_channels")
    .select("id")
    .eq("empresa_id", ctx.empresa_id)
    .in("id", uniq);
  if (cErr) throw new Error(cErr.message);
  const okIds = new Set((channels ?? []).map((c) => c.id as string));
  const rows = uniq.filter((id) => okIds.has(id)).map((channel_id) => ({
    empresa_id: ctx.empresa_id,
    queue_id: qid,
    channel_id,
  }));
  if (rows.length === 0) return;
  const { error: insErr } = await ctx.supabase.from("chat_queue_channels").insert(rows);
  if (insErr) throw new Error(insErr.message);
}

export async function repoListChatChannels(ctx: QueueAdminTenantContext): Promise<QueueEditorChatChannelRow[]> {
  const { data, error } = await ctx.supabase
    .from("chat_channels")
    .select(
      "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, connection_mode, config_status, config, created_at, updated_at"
    )
    .eq("empresa_id", ctx.empresa_id)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapChatChannelRow(r as Record<string, unknown>));
}

export async function repoListAgentsForQueue(ctx: QueueAdminTenantContext, queueId: string): Promise<QueueAgentRow[]> {
  const qid = queueId.trim();
  const { data: agents, error } = await ctx.supabase
    .from("chat_agents")
    .select("id, usuario_id, is_online, max_conversations, is_active, receives_new_chats, priority_in_queue")
    .eq("empresa_id", ctx.empresa_id)
    .eq("queue_id", qid)
    .order("priority_in_queue", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = agents ?? [];
  const uids = [...new Set(rows.map((r) => r.usuario_id as string))];
  let usuarioById: Record<string, { nombre: string | null; email: string | null }> = {};
  if (uids.length > 0) {
    const { data: urows, error: uErr } = await ctx.catalogSr.from("usuarios").select("id, nombre, email").in("id", uids);
    if (uErr) throw new Error(uErr.message);
    usuarioById = Object.fromEntries(
      (urows ?? []).map((u) => [
        u.id as string,
        {
          nombre: (u as { nombre?: string | null }).nombre ?? null,
          email: (u as { email?: string | null }).email ?? null,
        },
      ])
    );
  }
  return rows.map((row) => {
    const uid = row.usuario_id as string;
    const u = usuarioById[uid];
    const nombre = (u?.nombre?.trim() || u?.email?.trim() || "—") as string;
    return {
      id: row.id as string,
      usuario_id: uid,
      nombre,
      email: (u?.email as string) ?? "",
      is_online: Boolean(row.is_online),
      max_conversations: (row.max_conversations as number) ?? 5,
      is_active: row.is_active !== false,
      receives_new_chats: row.receives_new_chats !== false,
      priority_in_queue: (row.priority_in_queue as number) ?? 0,
    };
  });
}

export async function repoAddAgentToQueue(
  ctx: QueueAdminTenantContext,
  input: {
    queue_id: string;
    usuario_id: string;
    max_conversations?: number;
    receives_new_chats?: boolean;
    priority_in_queue?: number;
  }
): Promise<void> {
  const qid = input.queue_id.trim();
  const uid = input.usuario_id.trim();
  const { data: q, error: qe } = await ctx.supabase
    .from("chat_queues")
    .select("id")
    .eq("id", qid)
    .eq("empresa_id", ctx.empresa_id)
    .maybeSingle();
  if (qe) throw new Error(qe.message);
  if (!q) throw new Error("Cola no encontrada");
  const { error } = await ctx.supabase.from("chat_agents").insert({
    empresa_id: ctx.empresa_id,
    queue_id: qid,
    usuario_id: uid,
    is_online: false,
    max_conversations: input.max_conversations ?? 5,
    is_active: true,
    receives_new_chats: input.receives_new_chats !== false,
    priority_in_queue: input.priority_in_queue ?? 0,
  });
  if (error) {
    if (error.message.includes("duplicate") || error.code === "23505") {
      throw new Error("Ese usuario ya está asignado a esta cola.");
    }
    throw new Error(error.message);
  }
}

export async function repoUpdateQueueAgent(
  ctx: QueueAdminTenantContext,
  input: {
    id: string;
    max_conversations: number;
    is_online?: boolean;
    is_active: boolean;
    receives_new_chats: boolean;
    priority_in_queue: number;
  }
): Promise<void> {
  const { error } = await ctx.supabase
    .from("chat_agents")
    .update({
      max_conversations: input.max_conversations,
      is_online: input.is_online ?? false,
      is_active: input.is_active,
      receives_new_chats: input.receives_new_chats,
      priority_in_queue: input.priority_in_queue,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id.trim())
    .eq("empresa_id", ctx.empresa_id);
  if (error) throw new Error(error.message);
}

export async function repoRemoveQueueAgent(ctx: QueueAdminTenantContext, agentId: string): Promise<void> {
  const { error } = await ctx.supabase.from("chat_agents").delete().eq("id", agentId.trim()).eq("empresa_id", ctx.empresa_id);
  if (error) throw new Error(error.message);
}

export async function repoListUsuariosForQueuePick(ctx: QueueAdminTenantContext): Promise<UsuarioPickRow[]> {
  const { data, error } = await ctx.catalogSr
    .from("usuarios")
    .select("id, nombre, email")
    .eq("empresa_id", ctx.empresa_id)
    .eq("estado", "activo")
    .order("nombre", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((u) => ({
    id: u.id as string,
    nombre: ((u as { nombre?: string | null }).nombre?.trim() || (u as { email?: string }).email || "—") as string,
    email: ((u as { email?: string | null }).email as string) ?? "",
  }));
}

export async function repoLoadQueueEditorBootstrap(ctx: QueueAdminTenantContext, queueId: string): Promise<{
  queue: ChatQueueAdminRow | null;
  channels: QueueEditorChatChannelRow[];
  linked: QueueChannelLink[];
  agents: QueueAgentRow[];
  usuarios: UsuarioPickRow[];
  /** Errores parciales (p. ej. tabla chat_queue_channels ausente); la cola igual puede cargarse. */
  bootstrapWarnings: string[];
}> {
  const qid = queueId.trim();
  if (!qid) {
    return { queue: null, channels: [], linked: [], agents: [], usuarios: [], bootstrapWarnings: [] };
  }

  const queue = await repoFetchQueue(ctx, qid);
  if (!queue) {
    return { queue: null, channels: [], linked: [], agents: [], usuarios: [], bootstrapWarnings: [] };
  }

  const settled = await Promise.allSettled([
    repoListChatChannels(ctx),
    repoListQueueChannelLinks(ctx, qid),
    repoListAgentsForQueue(ctx, qid),
    repoListUsuariosForQueuePick(ctx),
  ]);

  const labels = ["canales", "vínculos cola–canales", "agentes", "usuarios para asignar"] as const;
  const bootstrapWarnings: string[] = [];
  const channels = settled[0].status === "fulfilled" ? settled[0].value : [];
  const linked = settled[1].status === "fulfilled" ? settled[1].value : [];
  const agents = settled[2].status === "fulfilled" ? settled[2].value : [];
  const usuarios = settled[3].status === "fulfilled" ? settled[3].value : [];

  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      bootstrapWarnings.push(`No se pudieron cargar ${labels[i]}: ${msg}`);
    }
  });

  return { queue, channels, linked, agents, usuarios, bootstrapWarnings };
}
