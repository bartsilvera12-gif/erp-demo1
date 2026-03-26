"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  deleteChatChannel,
  fetchChatChannels,
  saveChatChannel,
  type ChatChannelRow,
  type ChatChannelFormInput,
} from "@/lib/chat/actions";

function emptyForm(): ChatChannelFormInput {
  return {
    nombre: "WhatsApp principal",
    meta_phone_number_id: "",
    provider_channel_id: "",
    activo: true,
    display_phone_number: "",
    whatsapp_access_token: "",
  };
}

export default function ConfiguracionCanalesPage() {
  const [rows, setRows] = useState<ChatChannelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ChatChannelFormInput>(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchChatChannels();
      setRows(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar canales");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  function startEdit(row: ChatChannelRow) {
    setEditingId(row.id);
    setForm({
      id: row.id,
      nombre: row.nombre ?? "WhatsApp",
      meta_phone_number_id: row.meta_phone_number_id,
      provider_channel_id: row.provider_channel_id ?? row.meta_phone_number_id,
      activo: row.activo,
      display_phone_number:
        typeof row.config?.display_phone_number === "string"
          ? row.config.display_phone_number
          : "",
      whatsapp_access_token: "",
    });
  }

  function startNew() {
    setEditingId(null);
    setForm(emptyForm());
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await saveChatChannel({
        ...form,
        id: editingId ?? undefined,
      });
      await reload();
      startNew();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("¿Eliminar este canal? Las conversaciones asociadas pueden quedar huérfanas.")) return;
    setSaving(true);
    try {
      await deleteChatChannel(id);
      await reload();
      if (editingId === id) startNew();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al eliminar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/dashboard/conversaciones" className="hover:text-slate-800">
          Conversaciones
        </Link>
        <span>/</span>
        <span className="text-slate-800 font-medium">Configuración WhatsApp</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-slate-800">Canal WhatsApp (Meta)</h1>
        <p className="text-sm text-slate-500 mt-1">
          Registrá el <strong>Phone number ID</strong> de la API de Meta. Es el mismo valor que envía el webhook en{" "}
          <code className="text-xs bg-slate-100 px-1 rounded">metadata.phone_number_id</code>.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2">{error}</div>
      )}

      <div className="bg-sky-50 border border-sky-200 text-sky-900 text-sm rounded-lg px-4 py-3 space-y-1">
        <p className="font-medium">Demo / servidor sin configurar aún</p>
        <p>
          Podés definir en Vercel:{" "}
          <code className="text-xs">WHATSAPP_DEFAULT_EMPRESA_ID</code> (UUID de tu empresa) y{" "}
          <code className="text-xs">WHATSAPP_PHONE_NUMBER_ID</code> (mismo ID que Meta). El primer webhook creará el
          canal automáticamente.
        </p>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
            {editingId ? "Editar canal" : "Nuevo canal"}
          </h2>
          {editingId && (
            <button type="button" onClick={startNew} className="text-sm text-[#0EA5E9] hover:underline">
              Cancelar edición
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Nombre en el ERP</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={form.nombre}
              onChange={(e) => setForm((p) => ({ ...p, nombre: e.target.value }))}
              placeholder="Ej: WhatsApp ventas"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
              Phone number ID (Graph API) *
            </label>
            <input
              required
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              value={form.meta_phone_number_id}
              onChange={(e) => setForm((p) => ({ ...p, meta_phone_number_id: e.target.value }))}
              placeholder="Ej: 123456789012345"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
              Provider channel ID (opcional)
            </label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              value={form.provider_channel_id}
              onChange={(e) => setForm((p) => ({ ...p, provider_channel_id: e.target.value }))}
              placeholder="Por defecto se usa el mismo Phone number ID"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
              Número visible (opcional)
            </label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={form.display_phone_number ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, display_phone_number: e.target.value }))}
              placeholder="+595 981 000000"
            />
            <p className="text-xs text-slate-400 mt-1">Se guarda en config para referencia; no afecta el webhook.</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
              Token de acceso Meta (enviar mensajes)
            </label>
            <input
              type="password"
              autoComplete="off"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              value={form.whatsapp_access_token ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, whatsapp_access_token: e.target.value }))}
              placeholder={
                editingId
                  ? "Dejar vacío para no cambiar el token guardado"
                  : "Pegá el token permanente de la app (WhatsApp)"
              }
            />
            <p className="text-xs text-slate-400 mt-1">
              Necesario para el botón Enviar en Conversaciones. Alternativa: variable{" "}
              <code className="text-[10px] bg-slate-100 px-1 rounded">WHATSAPP_TOKEN</code> en Vercel.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.activo}
              onChange={(e) => setForm((p) => ({ ...p, activo: e.target.checked }))}
            />
            Canal activo (recibe mensajes del webhook)
          </label>
          <button
            type="submit"
            disabled={saving}
            className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-50 text-white px-5 py-2.5 rounded-lg text-sm font-medium"
          >
            {saving ? "Guardando…" : editingId ? "Actualizar canal" : "Crear canal"}
          </button>
        </form>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-700">
          Canales registrados
        </div>
        {loading ? (
          <div className="p-8 text-center text-slate-400 text-sm animate-pulse">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">No hay canales. Creá uno con el formulario de arriba.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium text-slate-800">{r.nombre ?? "WhatsApp"}</p>
                  <p className="text-xs font-mono text-slate-600">phone_number_id: {r.meta_phone_number_id}</p>
                  <p className="text-xs text-slate-500">
                    {r.activo ? <span className="text-emerald-600">Activo</span> : <span className="text-amber-600">Inactivo</span>}
                    {" · "}
                    provider: {r.provider}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => startEdit(r)}
                    className="text-sm text-[#0EA5E9] hover:underline"
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(r.id)}
                    className="text-sm text-red-600 hover:underline"
                  >
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
