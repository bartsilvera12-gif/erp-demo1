"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { NotaCreditoListItemDTO } from "@/lib/nota-credito/types";

type NcApiGet = {
  success?: boolean;
  data?: {
    items: NotaCreditoListItemDTO[];
    puede_crear: boolean;
    motivo_bloqueo_creacion: string | null;
  };
  error?: string;
};

function labelEstadoErp(e: string) {
  const m: Record<string, string> = {
    borrador: "Borrador",
    pendiente_envio_sifen: "Pendiente envío SIFEN",
    aprobada: "Aprobada",
    rechazada: "Rechazada",
    error: "Error",
    anulada_borrador: "Anulada (borrador)",
  };
  return m[e] ?? e;
}

function labelEstadoSifen(e: string | null) {
  if (e == null || e === "") return "—";
  if (e === "sin_envio") return "Sin envío aún";
  return e;
}

function formatGs(n: number, moneda: string) {
  return moneda === "USD" ? n.toLocaleString("en-US") : n.toLocaleString("es-PY");
}

export function FacturaCorreccionFiscalNC({
  facturaId,
  clienteId,
  clienteDisplay,
  monto,
  saldo,
  estado,
  moneda,
  puedeCancelarDe,
  deAprobado,
  onAfterNcMutation,
}: {
  facturaId: string;
  clienteId: string;
  clienteDisplay: string;
  monto: number;
  saldo: number;
  estado: string;
  moneda: string;
  puedeCancelarDe: boolean;
  deAprobado: boolean;
  onAfterNcMutation?: () => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<NotaCreditoListItemDTO[]>([]);
  const [puedeCrear, setPuedeCrear] = useState(false);
  const [bloqueo, setBloqueo] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [obs, setObs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const monedaLabel = moneda === "USD" ? "USD" : "Gs.";

  const reload = useCallback(async () => {
    setLoading(true);
    setFlash(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/notas-credito`, { cache: "no-store" });
      const j = (await res.json()) as NcApiGet;
      if (!res.ok || !j.success || !j.data) {
        setItems([]);
        setPuedeCrear(false);
        setBloqueo(j.error ?? "No se pudo cargar notas de crédito");
        return;
      }
      setItems(j.data.items);
      setPuedeCrear(j.data.puede_crear);
      setBloqueo(j.data.motivo_bloqueo_creacion ?? null);
    } catch {
      setItems([]);
      setPuedeCrear(false);
      setBloqueo("Error de red");
    } finally {
      setLoading(false);
    }
  }, [facturaId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mostrarBloque = deAprobado || items.length > 0;
  if (!mostrarBloque) {
    return null;
  }

  async function handleCrear() {
    setFlash(null);
    const m = motivo.trim();
    if (m.length < 5) {
      setFlash({ kind: "err", text: "El motivo debe tener al menos 5 caracteres." });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/notas-credito`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          motivo: m,
          observacion_interna: obs.trim() || null,
        }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      setModalOpen(false);
      setMotivo("");
      setObs("");
      setFlash({ kind: "ok", text: "Nota de crédito creada en borrador. Próxima fase: envío a SIFEN." });
      await reload();
      await onAfterNcMutation?.();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setSubmitting(false);
    }
  }

  async function anularBorrador(nc: NotaCreditoListItemDTO) {
    if (!confirm("¿Anular esta nota de crédito en borrador? Podrás crear otra después.")) return;
    setFlash(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/notas-credito/${nc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "anular_borrador" }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      setFlash({ kind: "ok", text: "Borrador anulado." });
      await reload();
      await onAfterNcMutation?.();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-5 space-y-4">
      <div>
        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Corrección fiscal</h3>
        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
          Si el documento electrónico está <span className="font-semibold">aprobado</span> y todavía podés cancelarlo
          dentro del plazo, usá <span className="font-semibold">Cancelar factura (DE)</span> abajo: es la vía prioritaria.
          La <span className="font-semibold">nota de crédito</span> aplica cuando ya no corresponde cancelar (plazo vencido
          o hay pagos). En esta versión el monto es siempre el <span className="font-semibold">saldo pendiente</span>{" "}
          completo.
        </p>
      </div>

      {puedeCancelarDe && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
          Podés cancelar el DE dentro del plazo. La nota de crédito no está disponible hasta que deje de aplicar la
          cancelación.
        </div>
      )}

      {!puedeCancelarDe && deAprobado && estado !== "Anulado" && (
        <div className="space-y-2">
          {loading ? (
            <p className="text-xs text-slate-400">Cargando notas de crédito…</p>
          ) : puedeCrear ? (
            <button
              type="button"
              onClick={() => {
                setMotivo("");
                setObs("");
                setFlash(null);
                setModalOpen(true);
              }}
              className="px-3 py-2 text-xs font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 shadow-sm"
            >
              Emitir nota de crédito (saldo pendiente)
            </button>
          ) : (
            <div className="rounded-lg border border-amber-100 bg-amber-50/50 px-3 py-2 text-xs text-amber-950">
              <span className="font-semibold">No disponible:</span>{" "}
              {bloqueo ?? "No se puede crear una nota de crédito en este momento."}
            </div>
          )}
        </div>
      )}

      {flash && (
        <div
          className={`rounded-lg text-xs px-3 py-2 ${
            flash.kind === "ok"
              ? "bg-emerald-50 border border-emerald-200 text-emerald-900"
              : "bg-red-50 border border-red-200 text-red-900"
          }`}
        >
          {flash.text}
        </div>
      )}

      {items.length > 0 && (
        <div className="border-t border-slate-100 pt-3 space-y-2">
          <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Historial — Notas de crédito</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-1.5 pr-2">Fecha</th>
                  <th className="py-1.5 pr-2">Monto</th>
                  <th className="py-1.5 pr-2">Estado ERP</th>
                  <th className="py-1.5 pr-2">SIFEN</th>
                  <th className="py-1.5 pr-2">Usuario</th>
                  <th className="py-1.5 pr-2">Motivo</th>
                  <th className="py-1.5 pr-2">Id</th>
                  <th className="py-1.5">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((nc) => (
                  <tr key={nc.id} className="text-slate-800">
                    <td className="py-2 pr-2 whitespace-nowrap">
                      {new Date(nc.created_at).toLocaleString("es-PY", { dateStyle: "short", timeStyle: "short" })}
                    </td>
                    <td className="py-2 pr-2 tabular-nums font-medium">
                      {monedaLabel} {formatGs(nc.monto, moneda)}
                    </td>
                    <td className="py-2 pr-2">{labelEstadoErp(nc.estado_erp)}</td>
                    <td className="py-2 pr-2">{labelEstadoSifen(nc.estado_sifen)}</td>
                    <td className="py-2 pr-2 max-w-[140px] truncate" title={nc.created_by_email_snapshot ?? ""}>
                      {nc.created_by_nombre_snapshot ?? nc.created_by_email_snapshot ?? "—"}
                    </td>
                    <td className="py-2 pr-2 max-w-[180px] truncate" title={nc.motivo}>
                      {nc.motivo}
                    </td>
                    <td className="py-2 pr-2 font-mono text-[10px] text-slate-500">{nc.id.slice(0, 8)}…</td>
                    <td className="py-2">
                      {nc.estado_erp === "borrador" ? (
                        <button
                          type="button"
                          onClick={() => void anularBorrador(nc)}
                          className="text-amber-800 font-semibold hover:underline"
                        >
                          Anular borrador
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nc-modal-title"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-5 space-y-3 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <h4 id="nc-modal-title" className="text-sm font-bold text-slate-900">
              Crear nota de crédito (borrador)
            </h4>
            <dl className="grid grid-cols-2 gap-2 text-xs text-slate-700">
              <div className="col-span-2">
                <dt className="text-slate-400">Cliente</dt>
                <dd className="font-medium">
                  <Link href={`/clientes/${clienteId}`} className="text-[#0EA5E9] hover:underline">
                    {clienteDisplay || "Cliente"}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Factura</dt>
                <dd className="font-mono text-[11px]">{facturaId.slice(0, 8)}…</dd>
              </div>
              <div>
                <dt className="text-slate-400">Monto factura</dt>
                <dd className="tabular-nums font-semibold">
                  {monedaLabel} {formatGs(monto, moneda)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Pagos registrados (suma)</dt>
                <dd className="tabular-nums font-medium">
                  {monedaLabel} {formatGs(Math.max(0, monto - saldo), moneda)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Saldo pendiente (= NC)</dt>
                <dd className="tabular-nums font-bold text-amber-900">
                  {monedaLabel} {formatGs(saldo, moneda)}
                </dd>
              </div>
              <div className="col-span-2 text-[11px] text-slate-500">
                El sistema registrará el borrador con el saldo actual como monto de la NC. No se envía aún a SIFEN.
              </div>
            </dl>
            <label className="block text-xs font-semibold text-slate-600">
              Motivo (obligatorio)
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]"
                placeholder="Ej.: corrección acordada con el cliente por error de facturación"
              />
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              Observación interna (opcional)
              <textarea
                value={obs}
                onChange={(e) => setObs(e.target.value)}
                rows={2}
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]"
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setModalOpen(false)}
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleCrear()}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {submitting ? "Guardando…" : "Confirmar creación"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
