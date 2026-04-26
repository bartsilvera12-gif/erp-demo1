"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { enRangoCalendario, hoyYmdLocal, rangoDesdeHastaInputs, toCalendarDateStr } from "@/lib/fechas/calendario";
import { getFacturas } from "@/lib/gestion-clientes/storage";
import MontoInput from "@/components/ui/MontoInput";
import { getClientes } from "@/lib/clientes/storage";
import { etiquetaVisibleTipoServicio } from "@/lib/clientes/tipo-servicio-catalogo";
import { useMapNombreTipoServicioCatalogo } from "@/lib/clientes/use-map-nombre-tipo-servicio";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { apiCreatePago } from "@/lib/api/client";
import type { Cliente } from "@/lib/clientes/types";
import type { Factura } from "@/lib/gestion-clientes/types";

const inputClass = "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";
const labelClass = "block text-xs font-medium text-slate-500 mb-1";

type TabPagos = "pendientes" | "cobrados";

function formatFecha(str: string) {
  if (!str) return "—";
  const [y, m, d] = str.split("-");
  return `${d}/${m}/${y}`;
}

interface PagoCobrado {
  id: string;
  factura_numero: string;
  cliente_nombre: string;
  /** Nombre visible desde `cliente_tipos_servicio_catalogo` (resuelto en GET /api/pagos). */
  cliente_tipo_nombre: string;
  /** Slug normalizado (`clientes.tipo_servicio_cliente`); `null` = sin tipo. */
  cliente_tipo_slug: string | null;
  monto: number;
  fecha_pago: string;
  metodo_pago: string;
  usuario_email: string;
  referencia?: string;
}

export default function PagosPage() {
  const [tab, setTab] = useState<TabPagos>("pendientes");
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [cobrados, setCobrados] = useState<PagoCobrado[]>([]);
  const [cargandoCobrados, setCargandoCobrados] = useState(false);
  const [modalPago, setModalPago] = useState(false);
  const [facturaSeleccionada, setFacturaSeleccionada] = useState<Factura | null>(null);
  const [formPago, setFormPago] = useState({ monto: "", fecha_pago: "", metodo_pago: "efectivo" as const, referencia: "" });
  const [guardando, setGuardando] = useState(false);
  const [filtroDesde, setFiltroDesde] = useState("");
  const [filtroHasta, setFiltroHasta] = useState("");
  /** "" = todos, "__sin__" = sin clasificar, sino slug en minúsculas. */
  const [filtroTipoCliente, setFiltroTipoCliente] = useState("");

  const rangoFechas = useMemo(
    () => rangoDesdeHastaInputs(filtroDesde, filtroHasta),
    [filtroDesde, filtroHasta]
  );

  const fechaEnRangoCalendario = useCallback(
    (fechaRaw: string): boolean => {
      if (!rangoFechas) return true;
      const cal = toCalendarDateStr(fechaRaw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cal)) return false;
      return enRangoCalendario(cal, rangoFechas.desde, rangoFechas.hasta);
    },
    [rangoFechas]
  );

  useEffect(() => {
    getFacturas().then(setFacturas);
    getClientes().then(setClientes);
  }, []);

  const mapNombreTipoServicio = useMapNombreTipoServicioCatalogo(clientes);

  async function fetchCobrados() {
    setCargandoCobrados(true);
    try {
      const res = await fetchWithSupabaseSession("/api/pagos");
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setCobrados(
          json.data.map((p: Record<string, unknown>) => ({
            id: p.id as string,
            factura_numero: (p.factura_numero as string) ?? "—",
            cliente_nombre: (p.cliente_nombre as string) ?? "—",
            cliente_tipo_nombre: String(p.cliente_tipo_nombre ?? "—").trim() || "—",
            cliente_tipo_slug:
              p.cliente_tipo_slug === null || p.cliente_tipo_slug === undefined
                ? null
                : String(p.cliente_tipo_slug).trim() || null,
            monto: Number(p.monto) || 0,
            fecha_pago: toCalendarDateStr((p.fecha_pago as string) ?? "") || String(p.fecha_pago ?? "").slice(0, 10),
            metodo_pago: (p.metodo_pago as string) ?? "efectivo",
            usuario_email: (p.usuario_email as string) ?? "—",
            referencia: (p.referencia as string) || undefined,
          }))
        );
      } else {
        setCobrados([]);
      }
    } catch {
      setCobrados([]);
    } finally {
      setCargandoCobrados(false);
    }
  }

  useEffect(() => {
    if (tab === "cobrados") fetchCobrados();
  }, [tab]);

  const pendientesBase = useMemo(
    () =>
      facturas.filter((f) => {
        if (f.saldo <= 0 || f.estado === "Anulado" || f.estado === "Corregida NC") return false;
        const cli = clientes.find((c) => c.id === f.cliente_id);
        if (cli?.estado === "inactivo") return false;
        return true;
      }),
    [facturas, clientes]
  );

  const pendientesPorFecha = useMemo(() => {
    if (!rangoFechas) return pendientesBase;
    return pendientesBase.filter(
      (f) =>
        fechaEnRangoCalendario(f.fecha) ||
        fechaEnRangoCalendario(f.fecha_vencimiento)
    );
  }, [pendientesBase, rangoFechas, fechaEnRangoCalendario]);

  const pendientesVista = useMemo(() => {
    if (filtroTipoCliente === "") return pendientesPorFecha;
    if (filtroTipoCliente === "__sin__") {
      return pendientesPorFecha.filter((f) => {
        const c = clientes.find((x) => String(x.id) === String(f.cliente_id));
        return !c || !(c.tipo_servicio_cliente ?? "").trim();
      });
    }
    const slug = filtroTipoCliente.toLowerCase();
    return pendientesPorFecha.filter((f) => {
      const c = clientes.find((x) => String(x.id) === String(f.cliente_id));
      return (c?.tipo_servicio_cliente ?? "").trim().toLowerCase() === slug;
    });
  }, [pendientesPorFecha, filtroTipoCliente, clientes]);

  const cobradosPorFecha = useMemo(() => {
    if (!rangoFechas) return cobrados;
    return cobrados.filter((p) => fechaEnRangoCalendario(p.fecha_pago));
  }, [cobrados, rangoFechas, fechaEnRangoCalendario]);

  const cobradosVista = useMemo(() => {
    if (filtroTipoCliente === "") return cobradosPorFecha;
    if (filtroTipoCliente === "__sin__")
      return cobradosPorFecha.filter((p) => p.cliente_tipo_slug == null);
    const slug = filtroTipoCliente.toLowerCase();
    return cobradosPorFecha.filter((p) => p.cliente_tipo_slug === slug);
  }, [cobradosPorFecha, filtroTipoCliente]);

  const opcionesTipoFiltro = useMemo(() => {
    const s = new Set<string>();
    for (const c of clientes) {
      const t = (c.tipo_servicio_cliente ?? "").trim().toLowerCase();
      if (t) s.add(t);
    }
    for (const k of Object.keys(mapNombreTipoServicio)) s.add(k);
    return [...s]
      .sort()
      .map((slug) => ({
        value: slug,
        label: etiquetaVisibleTipoServicio(slug, mapNombreTipoServicio),
      }));
  }, [clientes, mapNombreTipoServicio]);

  /** Suma de saldos de filas filtradas (fechas + tipo de cliente). */
  const totalPendienteVista = useMemo(
    () =>
      pendientesVista.reduce(
        (acc, f) => acc + (Number.isFinite(f.saldo) ? f.saldo : 0),
        0
      ),
    [pendientesVista]
  );

  const totalCobradoVista = useMemo(
    () => cobradosVista.reduce((acc, p) => acc + (Number.isFinite(p.monto) ? p.monto : 0), 0),
    [cobradosVista]
  );

  const clienteMapNombre = useMemo(
    () => Object.fromEntries(clientes.map((c) => [c.id, (c.empresa ?? c.nombre_contacto) || "—"])),
    [clientes]
  );
  const labelTipoClienteFila = useCallback(
    (clienteId: string) => {
      const c = clientes.find((x) => String(x.id) === String(clienteId));
      if (!c) return "—";
      const t = (c.tipo_servicio_cliente ?? "").trim();
      if (!t) return "Sin clasificar";
      return etiquetaVisibleTipoServicio(t, mapNombreTipoServicio);
    },
    [clientes, mapNombreTipoServicio]
  );

  async function handleRegistrarPago(e: React.FormEvent) {
    e.preventDefault();
    const f = facturaSeleccionada;
    if (!f) return;
    const monto = parseFloat(formPago.monto) || 0;
    if (monto > f.saldo) {
      alert("El monto del pago no puede superar el saldo pendiente de la factura.");
      return;
    }
    setGuardando(true);
    const result = await apiCreatePago({
      factura_id: f.id,
      monto,
      fecha_pago: formPago.fecha_pago,
      metodo_pago: formPago.metodo_pago,
      referencia: formPago.referencia || undefined,
    });
    setGuardando(false);
    if (result) {
      setModalPago(false);
      setFacturaSeleccionada(null);
      getFacturas().then(setFacturas);
      if (tab === "cobrados") fetchCobrados();
    } else {
      alert("Error al registrar el pago. Verifique que el monto no supere el saldo.");
    }
  }

  const METODO_LABELS: Record<string, string> = {
    efectivo: "Efectivo",
    transferencia: "Transferencia",
    cheque: "Cheque",
    tarjeta: "Tarjeta",
    otro: "Otro",
  };

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">Pagos</h1>
        <p className="text-sm text-gray-500 mt-0.5">Registrar pagos de facturas pendientes de cobro</p>
      </div>

      <div className="flex gap-3 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setTab("pendientes")}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            tab === "pendientes" ? "bg-white border border-slate-200 border-b-white -mb-px text-[#0EA5E9]" : "text-slate-600 hover:text-slate-800"
          }`}
        >
          Pendientes
        </button>
        <button
          type="button"
          onClick={() => setTab("cobrados")}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            tab === "cobrados" ? "bg-white border border-slate-200 border-b-white -mb-px text-[#0EA5E9]" : "text-slate-600 hover:text-slate-800"
          }`}
        >
          Cobrados
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm">
        <p className="w-full text-xs text-slate-500 sm:mr-2 sm:max-w-[min(100%,20rem)]">
          Fechas (mismo criterio que el dashboard) y, opcionalmente, tipo de cliente. Los totales inferiores
          se recalculan con lo visible.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelClass}>Desde</label>
            <input
              type="date"
              value={filtroDesde}
              onChange={(e) => setFiltroDesde(e.target.value)}
              className={`${inputClass} w-[11rem]`}
            />
          </div>
          <div>
            <label className={labelClass}>Hasta</label>
            <input
              type="date"
              value={filtroHasta}
              onChange={(e) => setFiltroHasta(e.target.value)}
              className={`${inputClass} w-[11rem]`}
            />
          </div>
          <div>
            <label className={labelClass}>Tipo de cliente</label>
            <select
              value={filtroTipoCliente}
              onChange={(e) => setFiltroTipoCliente(e.target.value)}
              className={`${inputClass} min-w-[10.5rem] max-w-full sm:w-[14rem]`}
            >
              <option value="">Todos los tipos</option>
              <option value="__sin__">Sin clasificar</option>
              {opcionesTipoFiltro.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => {
              setFiltroDesde("");
              setFiltroHasta("");
              setFiltroTipoCliente("");
            }}
            className="border border-slate-300 bg-white px-3 py-2 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Limpiar filtros
          </button>
        </div>
      </div>

      {tab === "pendientes" && (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Facturas pendientes de cobro</h2>
          <span className="text-xs text-slate-500">
            {rangoFechas
              ? `${pendientesVista.length} según filtros · ${pendientesBase.length} con saldo en total`
              : `${pendientesVista.length} facturas con saldo (filtros)`}
          </span>
        </div>
        {pendientesBase.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            <p className="text-sm">No hay facturas pendientes de cobro.</p>
            <Link href="/clientes" className="text-[#0EA5E9] hover:underline text-sm mt-2 inline-block">
              Ir a Clientes →
            </Link>
          </div>
        ) : rangoFechas && pendientesPorFecha.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            <p className="text-sm">Ninguna factura con emisión o vencimiento en el rango de fechas.</p>
            <button
              type="button"
              onClick={() => {
                setFiltroDesde("");
                setFiltroHasta("");
                setFiltroTipoCliente("");
              }}
              className="text-[#0EA5E9] hover:underline text-xs mt-2"
            >
              Limpiar filtros
            </button>
          </div>
        ) : pendientesVista.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            <p className="text-sm">Ninguna factura con el tipo de cliente seleccionado.</p>
            <button
              type="button"
              onClick={() => setFiltroTipoCliente("")}
              className="text-[#0EA5E9] hover:underline text-xs mt-2"
            >
              Ver todos los tipos
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto overscroll-x-contain -mx-px sm:mx-0">
            <table className="w-full min-w-[920px] table-auto border-separate border-spacing-0 text-sm sm:min-w-0 sm:w-full">
              <thead className="bg-slate-50">
                <tr>
                  {["Número", "Cliente", "Tipo de cliente", "Fecha", "Vencimiento", "Total", "Saldo", "Estado", "Acción"].map((h) => (
                    <th
                      key={h}
                      className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 first:pl-4 last:pr-4 sm:px-4 sm:first:pl-5 sm:last:pr-5 lg:px-5"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pendientesVista.map((f) => (
                  <tr key={f.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-sm text-slate-800 first:pl-4 sm:px-4 sm:first:pl-5 lg:px-5">
                      {f.numero_factura}
                    </td>
                    <td className="min-w-[9rem] px-3 py-2.5 sm:min-w-[12rem] sm:px-4 lg:min-w-[16rem] xl:min-w-[20rem]">
                      <Link
                        href={`/clientes/${f.cliente_id}`}
                        className="block min-w-0 break-words [overflow-wrap:anywhere] text-sm font-medium text-[#0EA5E9] hover:underline"
                        title={String(clienteMapNombre[String(f.cliente_id)] ?? `Cliente #${String(f.cliente_id).slice(0, 8)}`)}
                      >
                        {clienteMapNombre[String(f.cliente_id)] ?? `Cliente #${String(f.cliente_id).slice(0, 8)}`}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-slate-700 sm:px-4">
                      <span
                        className="inline-block max-w-[20rem] text-slate-600 2xl:whitespace-nowrap 2xl:max-w-none"
                        title={labelTipoClienteFila(String(f.cliente_id))}
                      >
                        {labelTipoClienteFila(String(f.cliente_id))}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600 sm:px-4">{formatFecha(f.fecha)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600 sm:px-4">{formatFecha(f.fecha_vencimiento)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-sm font-semibold tabular-nums text-slate-800 sm:px-4 sm:text-left">
                      Gs. {f.monto.toLocaleString("es-PY")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-sm font-semibold tabular-nums text-amber-600 sm:px-4 sm:text-left">
                      Gs. {f.saldo.toLocaleString("es-PY")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 sm:px-4">
                      <span className="inline-block text-xs font-medium whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-0.5 text-amber-800">
                        {f.estado}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 last:pr-4 sm:px-4 sm:last:pr-5">
                      <button
                        type="button"
                        onClick={() => {
                          setFacturaSeleccionada(f);
                          setFormPago({ monto: String(f.saldo), fecha_pago: hoyYmdLocal(), metodo_pago: "efectivo", referencia: "" });
                          setModalPago(true);
                        }}
                        className="text-xs font-medium text-[#0EA5E9] hover:underline"
                      >
                        Registrar pago
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={9} className="p-0">
                    <div
                      className="flex w-full min-w-0 flex-col items-stretch gap-2 border-t-2 border-slate-200 bg-slate-50/90 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      role="status"
                    >
                      <p className="shrink-0 text-xs font-semibold text-slate-700 sm:max-w-[40%] sm:pr-2">
                        {rangoFechas
                          ? filtroTipoCliente
                            ? "Total pendiente (filtros activos)"
                            : "Total pendiente en el rango"
                          : filtroTipoCliente
                            ? "Total pendiente (filtros activos)"
                            : "Total pendiente en esta vista"}
                      </p>
                      <p
                        className="min-w-0 flex-1 whitespace-nowrap text-center text-sm font-bold tabular-nums text-[#0EA5E9] sm:px-2"
                        style={{ lineHeight: 1.25 }}
                      >
                        {`Gs. ${totalPendienteVista.toLocaleString("es-PY")}`}
                      </p>
                      <p className="shrink-0 text-left text-[11px] text-slate-500 sm:max-w-[32%] sm:text-right">
                        {pendientesVista.length} registro{pendientesVista.length === 1 ? "" : "s"} · se
                        recalcula al cambiar el filtro
                      </p>
                    </div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      )}

      {tab === "cobrados" && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-700">Pagos registrados</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Solo filas de la tabla de pagos (mismo criterio que “Cobrado del período” en el dashboard financiero).
              </p>
            </div>
            <span className="text-xs text-slate-500">
              {cobrados.length > 0
                ? `${cobradosVista.length} según filtros · ${cobrados.length} en total`
                : "0 pagos"}
            </span>
          </div>
          {cargandoCobrados ? (
            <div className="p-12 text-center text-slate-500 text-sm">Cargando…</div>
          ) : cobrados.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <p className="text-sm">No hay pagos registrados.</p>
              <span className="text-xs mt-2 block">Los pagos aparecerán aquí cuando los registres.</span>
            </div>
          ) : rangoFechas && cobradosPorFecha.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <p className="text-sm">Ningún pago en el rango de fechas seleccionado.</p>
              <button
                type="button"
                onClick={() => {
                  setFiltroDesde("");
                  setFiltroHasta("");
                  setFiltroTipoCliente("");
                }}
                className="text-[#0EA5E9] hover:underline text-xs mt-2"
              >
                Limpiar filtros
              </button>
            </div>
          ) : cobradosVista.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <p className="text-sm">Ningún pago con el tipo de cliente seleccionado.</p>
              <button
                type="button"
                onClick={() => setFiltroTipoCliente("")}
                className="text-[#0EA5E9] hover:underline text-xs mt-2"
              >
                Ver todos los tipos
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto overscroll-x-contain -mx-px sm:mx-0">
              <table className="w-full min-w-[1000px] table-auto border-separate border-spacing-0 text-sm sm:min-w-0 sm:w-full">
                <thead className="bg-slate-50">
                  <tr>
                    {["Factura", "Cliente", "Tipo de cliente", "Monto pagado", "Fecha", "Método", "Usuario", "Referencia"].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 first:pl-4 last:pr-4 sm:px-4 sm:first:pl-5 sm:last:pr-5 lg:px-5"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {cobradosVista.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-sm text-slate-800 first:pl-4 sm:px-4 sm:first:pl-5 lg:px-5">
                        {p.factura_numero}
                      </td>
                      <td className="min-w-[9rem] px-3 py-2.5 sm:min-w-[12rem] sm:px-4 lg:min-w-[16rem] xl:min-w-[20rem]">
                        <span
                          className="block min-w-0 break-words [overflow-wrap:anywhere] text-sm font-medium text-slate-800"
                          title={p.cliente_nombre}
                        >
                          {p.cliente_nombre}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-slate-700 sm:px-4">
                        <span
                          className="inline-block max-w-[20rem] text-slate-600 2xl:whitespace-nowrap 2xl:max-w-none"
                          title={p.cliente_tipo_nombre}
                        >
                          {p.cliente_tipo_nombre}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-sm font-semibold tabular-nums text-slate-800 sm:px-4 sm:text-left">
                        Gs. {p.monto.toLocaleString("es-PY")}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-600 sm:px-4">
                        {formatFecha(p.fecha_pago)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-600 sm:px-4">
                        {METODO_LABELS[p.metodo_pago] ?? p.metodo_pago}
                      </td>
                      <td className="px-3 py-2.5 text-sm text-slate-600 sm:px-4 [overflow-wrap:anywhere] break-words">
                        {p.usuario_email}
                      </td>
                      <td className="min-w-[6rem] px-3 py-2.5 text-sm text-slate-500 sm:px-4 [overflow-wrap:anywhere] break-words last:pr-4 sm:last:pr-5">
                        {p.referencia || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={8} className="p-0">
                      <div
                        className="flex w-full min-w-0 flex-col items-stretch gap-2 border-t-2 border-slate-200 bg-slate-50/90 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                        role="status"
                      >
                        <p className="shrink-0 text-xs font-semibold text-slate-700 sm:max-w-[40%] sm:pr-2">
                          {rangoFechas
                            ? filtroTipoCliente
                              ? "Total cobrado (filtros activos)"
                              : "Total cobrado en el rango"
                            : filtroTipoCliente
                              ? "Total cobrado (filtros activos)"
                              : "Total cobrado en esta vista"}
                        </p>
                        <p
                          className="min-w-0 flex-1 whitespace-nowrap text-center text-sm font-bold tabular-nums text-[#0EA5E9] sm:px-2"
                          style={{ lineHeight: 1.25 }}
                        >
                          {`Gs. ${totalCobradoVista.toLocaleString("es-PY")}`}
                        </p>
                        <p className="shrink-0 text-left text-[11px] text-slate-500 sm:max-w-[32%] sm:text-right">
                          {cobradosVista.length} registro{cobradosVista.length === 1 ? "" : "s"} · se
                          recalcula al cambiar el filtro
                        </p>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {modalPago && facturaSeleccionada && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setModalPago(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-4">Registrar pago</h3>
            <p className="text-sm text-slate-600 mb-4">
              Factura {facturaSeleccionada.numero_factura} — Saldo: Gs. {facturaSeleccionada.saldo.toLocaleString("es-PY")}
            </p>
            <form onSubmit={handleRegistrarPago} className="space-y-4">
              <div>
                <label className={labelClass}>Monto</label>
                <MontoInput
                  value={formPago.monto}
                  onChange={(n) => setFormPago((p) => ({ ...p, monto: String(n) }))}
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label className={labelClass}>Fecha pago</label>
                <input type="date" value={formPago.fecha_pago} onChange={(e) => setFormPago((p) => ({ ...p, fecha_pago: e.target.value }))} className={inputClass} required />
              </div>
              <div>
                <label className={labelClass}>Método de pago</label>
                <select value={formPago.metodo_pago} onChange={(e) => setFormPago((p) => ({ ...p, metodo_pago: e.target.value as "efectivo" }))} className={inputClass}>
                  <option value="efectivo">Efectivo</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="cheque">Cheque</option>
                  <option value="tarjeta">Tarjeta</option>
                  <option value="otro">Otro</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Referencia</label>
                <input type="text" value={formPago.referencia} onChange={(e) => setFormPago((p) => ({ ...p, referencia: e.target.value }))} className={inputClass} placeholder="Nº de comprobante" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={guardando} className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                  Guardar
                </button>
                <button type="button" onClick={() => setModalPago(false)} className="border border-slate-200 px-4 py-2 rounded-lg text-sm hover:bg-slate-50">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
