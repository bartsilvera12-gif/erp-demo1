"use client";

import { ChevronDown, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ConfigMetricCard } from "@/components/config/global-config-primitives";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

const BASE_LABEL: Record<string, string> = {
  pago_registrado: "Pago registrado",
  factura_emitida: "Factura emitida",
  factura_pagada: "Factura pagada",
};

type Linea = {
  tipo: string;
  cliente_label: string;
  factura_id: string | null;
  numero_factura?: string | null;
  pago_id: string | null;
  fecha: string | null;
  monto_base: number;
  comision_estimada_linea: number;
};

type VendedorRow = {
  vendedor_usuario_id: string;
  vendedor_nombre: string;
  cantidad_movimientos: number;
  revenue_base: number;
  escala_aplicada: string;
  porcentaje_tramo: number;
  premio_fijo_tramo: number;
  comision_estimada: number;
  lineas: Linea[];
};

type PreviewMeta = {
  preview?: boolean;
  periodo?: string;
  timezone?: string;
  modo_periodo?: string;
  fecha_inicio_local?: string;
  fecha_fin_local?: string;
  politica_nombre?: string;
  base_calculo?: string;
  sin_escalas?: boolean;
  alcance?: string;
  supervisor_equipos_pendiente?: boolean;
  documentacion_base?: Record<string, string>;
};

type PreviewKpis = {
  revenue_base_total: number;
  comision_estimada_total: number;
  vendedores_con_comision: number;
  fuentes_sin_vendedor: number;
  alertas_sin_vendedor_pagos: number;
  alertas_sin_vendedor_facturas: number;
};

type PreviewPayload = {
  estado: string;
  mensaje?: string;
  meta: PreviewMeta | null;
  kpis: PreviewKpis | null;
  por_vendedor: VendedorRow[];
};

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("es-PY", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
}

export default function ComisionesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PreviewPayload | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/comisiones/preview", { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: PreviewPayload; error?: string };
      if (!res.ok || json.success !== true || !json.data) {
        throw new Error(json.error ?? `Error ${res.status}`);
      }
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 text-center text-sm text-slate-500">
        Cargando vista previa de comisiones…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-sky-700 hover:underline"
        >
          <RefreshCw className="h-4 w-4" />
          Reintentar
        </button>
      </div>
    );
  }

  const estado = data?.estado ?? "";
  const meta = data?.meta;
  const kpis = data?.kpis;
  const rows = data?.por_vendedor ?? [];

  if (estado === "sin_politica" || estado === "politica_inactiva") {
    return (
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Comisiones</h1>
          <p className="mt-1 text-sm text-slate-600">{data?.mensaje}</p>
        </div>
        <Link
          href="/configuracion/comisiones"
          className="inline-flex rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-semibold text-sky-900 hover:bg-sky-100"
        >
          Ir a Configuración → Comisiones
        </Link>
      </div>
    );
  }

  const baseLabel = BASE_LABEL[meta?.base_calculo ?? ""] ?? meta?.base_calculo ?? "—";

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Comisiones</h1>
          <p className="mt-1 text-sm text-slate-600">
            Vista previa del período actual según la política activa. No genera liquidaciones ni modifica datos.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Recalcular
          </button>
          <Link
            href="/configuracion/comisiones"
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
          >
            Configuración
          </Link>
        </div>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <span className="font-semibold">Vista previa.</span> No genera liquidación, no escribe líneas de comisión ni
        afecta facturas o pagos.
      </div>

      {meta?.supervisor_equipos_pendiente && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          Alcance de supervisor por equipos: pendiente de definir; hoy se muestra la empresa completa.
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Período actual</p>
            <p className="mt-1 text-lg font-semibold capitalize text-slate-900">{meta?.periodo ?? "—"}</p>
            <p className="text-xs text-slate-500">
              {meta?.fecha_inicio_local} → {meta?.fecha_fin_local} · {meta?.timezone}
            </p>
          </div>
          <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-sky-900">
            Preview · No cerrado
          </span>
        </div>
        <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <ConfigMetricCard label="Política activa" value={meta?.politica_nombre ?? "—"} />
          <ConfigMetricCard label="Base de cálculo" value={baseLabel} />
          <ConfigMetricCard
            label="Escalas"
            value={meta?.sin_escalas ? "Sin escalas (comisión 0)" : "Configuradas"}
          />
        </div>
      </section>

      {kpis && (
        <section>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Resumen</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ConfigMetricCard label="Revenue base total" value={fmtMoney(kpis.revenue_base_total)} />
            <ConfigMetricCard label="Comisión estimada total" value={fmtMoney(kpis.comision_estimada_total)} />
            <ConfigMetricCard label="Vendedores con comisión" value={kpis.vendedores_con_comision} />
            <ConfigMetricCard
              label="Fuentes sin vendedor"
              value={kpis.fuentes_sin_vendedor}
              sub={
                kpis.fuentes_sin_vendedor > 0
                  ? `${kpis.alertas_sin_vendedor_pagos} pagos · ${kpis.alertas_sin_vendedor_facturas} facturas/líneas`
                  : undefined
              }
            />
          </div>
          {kpis.fuentes_sin_vendedor > 0 && (
            <p className="mt-2 text-xs text-amber-800">
              Hay movimientos comerciales sin <code className="rounded bg-amber-100 px-1">vendedor_usuario_id</code> en
              el cliente; no ingresan al reparto por vendedor.
            </p>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Por vendedor</h2>
        {rows.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
            No hay movimientos con vendedor asignado en este período para la base seleccionada.
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <details
                key={r.vendedor_usuario_id}
                className="group rounded-2xl border border-slate-200 bg-white shadow-sm open:shadow-md"
              >
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-4 pr-3 [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">{r.vendedor_nombre}</p>
                    <p className="text-xs text-slate-500">
                      {r.cantidad_movimientos} movimientos · escala: {r.escala_aplicada}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-right">
                    <div>
                      <p className="text-[10px] font-semibold uppercase text-slate-400">Revenue base</p>
                      <p className="text-sm font-bold tabular-nums text-slate-800">{fmtMoney(r.revenue_base)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase text-slate-400">Comisión est.</p>
                      <p className="text-sm font-bold tabular-nums text-emerald-800">{fmtMoney(r.comision_estimada)}</p>
                    </div>
                    <ChevronDown className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
                  </div>
                </summary>
                <div className="border-t border-slate-100 px-4 pb-4">
                  <div className="overflow-x-auto">
                    <table className="mt-3 w-full min-w-[640px] text-left text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                          <th className="py-2 pr-2">Cliente</th>
                          <th className="py-2 pr-2">Tipo</th>
                          <th className="py-2 pr-2">Factura</th>
                          <th className="py-2 pr-2">Pago</th>
                          <th className="py-2 pr-2">Fecha</th>
                          <th className="py-2 pr-2 text-right">Monto base</th>
                          <th className="py-2 text-right">Comisión est.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.lineas.map((ln, i) => (
                          <tr key={`${ln.pago_id ?? ""}-${ln.factura_id ?? ""}-${i}`} className="border-b border-slate-50">
                            <td className="py-2 pr-2 text-slate-800">{ln.cliente_label}</td>
                            <td className="py-2 pr-2 text-xs text-slate-600">{ln.tipo.replace(/_/g, " ")}</td>
                            <td className="py-2 pr-2 font-mono text-xs text-slate-700">
                              {ln.numero_factura ?? ln.factura_id?.slice(0, 8) ?? "—"}
                            </td>
                            <td className="py-2 pr-2 font-mono text-xs text-slate-600">{ln.pago_id?.slice(0, 8) ?? "—"}</td>
                            <td className="py-2 pr-2 text-xs text-slate-600">{ln.fecha ?? "—"}</td>
                            <td className="py-2 pr-2 text-right tabular-nums">{fmtMoney(ln.monto_base)}</td>
                            <td className="py-2 text-right tabular-nums text-emerald-800">
                              {fmtMoney(ln.comision_estimada_linea)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    Premio fijo del tramo: {fmtMoney(r.premio_fijo_tramo)} · Porcentaje aplicado al total:{" "}
                    {r.porcentaje_tramo}%
                  </p>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>

      {meta?.documentacion_base && (
        <section className="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3 text-xs text-slate-600">
          <p className="font-semibold text-slate-700">Criterios de esta base</p>
          <ul className="mt-2 list-inside list-disc space-y-1">
            <li>
              <strong>Pago registrado:</strong> {meta.documentacion_base.pago_registrado}
            </li>
            <li>
              <strong>Factura emitida:</strong> {meta.documentacion_base.factura_emitida}
            </li>
            <li>
              <strong>Factura pagada:</strong> {meta.documentacion_base.factura_pagada}
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
