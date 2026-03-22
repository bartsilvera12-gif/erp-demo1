"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getMarketingTasksDelMes,
  getMetricasCumplimiento,
  updateTaskStatus,
} from "@/lib/marketing/storage";
import { getClientes, clienteNombre } from "@/lib/clientes/storage";
import type { MarketingTask } from "@/lib/marketing/types";
import type { Cliente } from "@/lib/clientes/types";
import { ChevronDown, ChevronRight } from "lucide-react";

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const hoy = new Date().toISOString().slice(0, 10);

function esCumplida(t: MarketingTask): boolean {
  return t.estado === "aprobado" || t.estado === "publicado";
}

function estiloTarea(t: MarketingTask): string {
  if (esCumplida(t)) return "bg-green-100 border-green-200 text-green-800";
  if (t.fecha_entrega < hoy) return "bg-red-100 border-red-200 text-red-800";
  return "bg-amber-50 border-amber-200 text-amber-700";
}

export default function MarketingOpsPage() {
  const mesActual = new Date().toISOString().slice(0, 7);
  const [mes, setMes] = useState(mesActual);
  const [tareas, setTareas] = useState<MarketingTask[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [metricas, setMetricas] = useState({ total: 0, completadas: 0, porcentaje: 0 });
  const [cargando, setCargando] = useState(true);
  const [expandidoId, setExpandidoId] = useState<string | null>(null);

  const [modalTarea, setModalTarea] = useState<MarketingTask | null>(null);
  const [marcandoCumplida, setMarcandoCumplida] = useState(false);

  const [regenerarCliente, setRegenerarCliente] = useState<Cliente | null>(null);
  const [regenerando, setRegenerando] = useState(false);

  const [syncPreview, setSyncPreview] = useState<{
    clientes_a_marcar_count: number;
    tareas_a_generar_count: number;
    clientes_a_marcar: { id: string; nombre: string }[];
  } | null>(null);
  const [syncEjecutando, setSyncEjecutando] = useState(false);
  const [syncMostrarPreview, setSyncMostrarPreview] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    Promise.all([
      getMarketingTasksDelMes(mes),
      getClientes(),
      getMetricasCumplimiento(mes),
    ])
      .then(([tMes, c, met]) => {
        setTareas(tMes);
        setClientes(c);
        setMetricas(met);
      })
      .catch(() => {})
      .finally(() => setCargando(false));
  }, [mes]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const clientesMarketing = useMemo(
    () => clientes.filter((c) => c.tipo_servicio_cliente === "marketing" && c.estado === "activo"),
    [clientes]
  );

  const [ano, mesNum] = mes.split("-").map(Number);

  const tareasPorCliente = useMemo(() => {
    const map = new Map<string, MarketingTask[]>();
    for (const t of tareas) {
      const list = map.get(t.cliente_id) ?? [];
      list.push(t);
      map.set(t.cliente_id, list);
    }
    return map;
  }, [tareas]);

  const cumplimientoPorCliente = useMemo(() => {
    const map = new Map<string, { completadas: number; total: number }>();
    for (const [cid, list] of tareasPorCliente) {
      const completadas = list.filter(esCumplida).length;
      map.set(cid, { completadas, total: list.length });
    }
    return map;
  }, [tareasPorCliente]);

  const grupoPorDiaPorCliente = useMemo(() => {
    const map = new Map<string, Map<string, MarketingTask[]>>();
    for (const [cid, list] of tareasPorCliente) {
      const porDia = new Map<string, MarketingTask[]>();
      for (const t of list) {
        const l = porDia.get(t.fecha_entrega) ?? [];
        l.push(t);
        porDia.set(t.fecha_entrega, l);
      }
      map.set(cid, porDia);
    }
    return map;
  }, [tareasPorCliente]);

  const diasDelMes = useMemo(() => {
    const ultimo = new Date(ano, mesNum, 0).getDate();
    const dias: string[] = [];
    for (let d = 1; d <= ultimo; d++) {
      dias.push(`${mes}-${String(d).padStart(2, "0")}`);
    }
    return dias;
  }, [mes, ano, mesNum]);

  const atrasadas = useMemo(
    () => tareas.filter((t) => t.fecha_entrega < hoy && !esCumplida(t)),
    [tareas]
  );
  const tareasHoy = useMemo(() => tareas.filter((t) => t.fecha_entrega === hoy), [tareas]);
  const finSemana = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  }, []);
  const semana = useMemo(
    () => tareas.filter((t) => t.fecha_entrega > hoy && t.fecha_entrega <= finSemana),
    [tareas, finSemana]
  );

  async function handlePreviewSync() {
    try {
      const res = await fetch(`/api/marketing/sync?preview=1&mes=${mes}`);
      const json = await res.json();
      if (res.ok && json.data) {
        setSyncPreview({
          clientes_a_marcar_count: json.data.resumen?.clientes_a_marcar_count ?? 0,
          tareas_a_generar_count: json.data.resumen?.tareas_a_generar_count ?? 0,
          clientes_a_marcar: json.data.clientes_a_marcar ?? [],
        });
        setSyncMostrarPreview(true);
      }
    } catch {
      setSyncPreview(null);
    }
  }

  async function handleExecuteSync() {
    setSyncEjecutando(true);
    try {
      const res = await fetch("/api/marketing/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mes, confirmar: true }),
      });
      if (res.ok) {
        setSyncMostrarPreview(false);
        setSyncPreview(null);
        cargar();
      } else {
        const json = await res.json();
        alert(json.error ?? "Error al sincronizar");
      }
    } catch {
      alert("Error al sincronizar");
    } finally {
      setSyncEjecutando(false);
    }
  }

  async function handleMarcarCumplida(tarea: MarketingTask) {
    setMarcandoCumplida(true);
    const actualizada = await updateTaskStatus(tarea.id, "aprobado");
    setMarcandoCumplida(false);
    setModalTarea(null);
    if (actualizada) {
      setTareas((prev) => prev.map((t) => (t.id === tarea.id ? actualizada : t)));
      const met = await getMetricasCumplimiento(mes);
      setMetricas(met);
    }
  }

  async function handleRegenerarTareas(cli: Cliente) {
    setRegenerando(true);
    try {
      const res = await fetch("/api/marketing/regenerar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mes, cliente_id: cli.id, confirmar: true }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setRegenerarCliente(null);
        cargar();
      } else {
        alert(json.error ?? "Error al regenerar tareas");
      }
    } catch {
      alert("Error al regenerar tareas");
    } finally {
      setRegenerando(false);
    }
  }

  if (cargando && tareas.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-gray-800">Marketing Ops</h1>
        <div className="py-16 text-center text-gray-400 text-sm animate-pulse">Cargando…</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">Marketing Ops</h1>
          <p className="text-gray-500 text-sm mt-1">Ejecución por cliente</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handlePreviewSync}
            className="text-sm font-medium px-4 py-2 rounded-lg border border-slate-200 hover:bg-slate-50"
          >
            Sincronizar (preview)
          </button>
          <select
            value={mes}
            onChange={(e) => setMes(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2"
          >
            {Array.from({ length: 24 }, (_, i) => {
              const d = new Date();
              d.setMonth(d.getMonth() - 6 + i);
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, "0");
              const val = `${y}-${m}`;
              return (
                <option key={val} value={val}>
                  {MESES[d.getMonth()]} {y}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {/* Dashboard */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-red-50 border border-red-100 rounded-xl p-4">
          <p className="text-xs font-semibold text-red-600 uppercase">Atrasadas</p>
          <p className="text-2xl font-bold text-red-800">{atrasadas.length}</p>
        </div>
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
          <p className="text-xs font-semibold text-amber-600 uppercase">Hoy</p>
          <p className="text-2xl font-bold text-amber-800">{tareasHoy.length}</p>
        </div>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
          <p className="text-xs font-semibold text-blue-600 uppercase">Esta semana</p>
          <p className="text-2xl font-bold text-blue-800">{semana.length}</p>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-semibold text-slate-600 uppercase">Clientes marketing</p>
          <p className="text-2xl font-bold text-slate-800">{clientesMarketing.length}</p>
        </div>
        <div className="bg-green-50 border border-green-100 rounded-xl p-4">
          <p className="text-xs font-semibold text-green-600 uppercase">Cumplimiento {mes}</p>
          <p className="text-2xl font-bold text-green-800">{metricas.porcentaje}%</p>
          <p className="text-xs text-green-600">{metricas.completadas}/{metricas.total} tareas</p>
        </div>
      </div>

      {/* Sync modal */}
      {syncMostrarPreview && syncPreview && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setSyncMostrarPreview(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-4">Preview de sincronización — {mes}</h3>
            <p className="text-sm"><strong>{syncPreview.clientes_a_marcar_count}</strong> clientes a marcar</p>
            <p className="text-sm"><strong>{syncPreview.tareas_a_generar_count}</strong> tareas a generar</p>
            <div className="flex gap-3 mt-6">
              <button
                type="button"
                onClick={handleExecuteSync}
                disabled={syncEjecutando}
                className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {syncEjecutando ? "Ejecutando…" : "Ejecutar"}
              </button>
              <button type="button" onClick={() => setSyncMostrarPreview(false)} className="border border-slate-200 px-4 py-2 rounded-lg text-sm hover:bg-slate-50">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal regenerar tareas */}
      {regenerarCliente && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setRegenerarCliente(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-2">Regenerar tareas del mes</h3>
            <p className="text-sm text-gray-600 mb-4">
              Se eliminarán las <strong>tareas automáticas</strong> de <strong>{clienteNombre(regenerarCliente)}</strong> en <strong>{MESES[mesNum - 1]} {ano}</strong> y se generarán nuevas según la plantilla actual del plan.
            </p>
            <p className="text-xs text-amber-600 mb-4">Las tareas manuales no se modificarán.</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => handleRegenerarTareas(regenerarCliente)}
                disabled={regenerando}
                className="flex-1 bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {regenerando ? "Regenerando…" : "Confirmar"}
              </button>
              <button
                type="button"
                onClick={() => setRegenerarCliente(null)}
                disabled={regenerando}
                className="border border-slate-200 px-4 py-2 rounded-lg text-sm hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal cumplimiento */}
      {modalTarea && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setModalTarea(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-2">¿Se cumplió esta tarea?</h3>
            <p className="text-sm text-gray-600 mb-4 capitalize">{modalTarea.tipo_contenido} — {modalTarea.fecha_entrega}</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => handleMarcarCumplida(modalTarea)}
                disabled={marcandoCumplida}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {marcandoCumplida ? "…" : "Sí"}
              </button>
              <button
                type="button"
                onClick={() => setModalTarea(null)}
                className="flex-1 border border-slate-200 px-4 py-2 rounded-lg text-sm hover:bg-slate-50"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lista de clientes como tarjetas */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wider">
          Clientes marketing — {MESES[mesNum - 1]} {ano}
        </h2>

        {clientesMarketing.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 py-12 text-center text-gray-400">
            <p>No hay clientes marketing activos.</p>
            <p className="text-sm mt-1">Asigná tipo de servicio &quot;marketing&quot; a clientes o sincronizá.</p>
          </div>
        ) : (
          clientesMarketing.map((c) => {
            const expandido = expandidoId === c.id;
            const { completadas, total } = cumplimientoPorCliente.get(c.id) ?? { completadas: 0, total: 0 };
            const grupoPorDia = grupoPorDiaPorCliente.get(c.id) ?? new Map<string, MarketingTask[]>();

            return (
              <div
                key={c.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setExpandidoId(expandido ? null : c.id)}
                  className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {expandido ? (
                      <ChevronDown className="w-5 h-5 text-slate-500 shrink-0" />
                    ) : (
                      <ChevronRight className="w-5 h-5 text-slate-500 shrink-0" />
                    )}
                    <div>
                      <p className="font-semibold text-gray-800">{clienteNombre(c)}</p>
                      <p className="text-sm text-gray-500">
                        {total > 0 ? (
                          <span className={completadas === total ? "text-green-600" : ""}>
                            {completadas}/{total} tareas cumplidas
                          </span>
                        ) : (
                          "Sin tareas este mes"
                        )}
                      </p>
                    </div>
                  </div>
                </button>

                {expandido && (
                  <div className="border-t border-slate-100 p-4 bg-slate-50/50">
                    <div className="flex items-center justify-between gap-4 mb-3">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setRegenerarCliente(c); }}
                        className="text-xs font-medium text-[#0EA5E9] hover:underline"
                      >
                        Regenerar tareas del mes
                      </button>
                    </div>
                    <div className="grid grid-cols-7 min-w-[600px] gap-1" style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
                      {["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"].map((d) => (
                        <div key={d} className="text-center text-xs font-semibold text-slate-500 py-1">{d}</div>
                      ))}
                      {Array.from(
                        { length: diasDelMes.length ? new Date(ano, mesNum - 1, 1).getDay() : 0 },
                        (_, i) => <div key={`e-${i}`} className="min-h-[70px]" />
                      )}
                      {diasDelMes.map((fecha) => {
                        const tareasDia = grupoPorDia.get(fecha) ?? [];
                        const esHoy = fecha === hoy;
                        return (
                          <div
                            key={fecha}
                            className={`min-h-[70px] p-2 rounded-lg border ${
                              esHoy ? "border-[#0EA5E9] bg-sky-50" : "border-slate-200 bg-white"
                            }`}
                          >
                            <span className="text-xs font-medium text-slate-600">{fecha.slice(8)}</span>
                            <div className="mt-1 space-y-1">
                              {tareasDia.map((t) => (
                                <button
                                  key={t.id}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setModalTarea(t);
                                  }}
                                  className={`block w-full text-left text-xs truncate px-1.5 py-0.5 rounded border cursor-pointer hover:opacity-90 ${estiloTarea(t)}`}
                                >
                                  {t.tipo_contenido}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
