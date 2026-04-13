/** Estados ERP de `nota_credito` (fase 1). */
export type NotaCreditoEstadoErp =
  | "borrador"
  | "pendiente_envio_sifen"
  | "aprobada"
  | "rechazada"
  | "error"
  | "anulada_borrador";

/** Estados SIFEN del DE de la NC (`nota_credito_electronica`). */
export type NotaCreditoEstadoSifen =
  | "sin_envio"
  | "borrador"
  | "generado"
  | "firmado"
  | "enviado"
  | "aprobado"
  | "rechazado"
  | "error_envio"
  | "cancelado";

export type NotaCreditoEventoTipo =
  | "creacion"
  | "validacion"
  | "rechazo_negocio"
  | "cambio_estado_erp"
  | "preparacion_sifen"
  | "error"
  | "observacion_operativa"
  | "anulacion_borrador";

export type NotaCreditoListItemDTO = {
  id: string;
  monto: number;
  motivo: string;
  observacion_interna: string | null;
  estado_erp: NotaCreditoEstadoErp;
  created_at: string;
  created_by_user_id: string | null;
  created_by_email_snapshot: string | null;
  created_by_nombre_snapshot: string | null;
  saldo_previo_snapshot: number;
  monto_factura_snapshot: number;
  suma_pagos_snapshot: number;
  moneda_snapshot: string;
  estado_sifen: NotaCreditoEstadoSifen | null;
  cdc: string | null;
  cdc_factura_origen: string | null;
};

export type NotaCreditoCreateBody = {
  motivo: string;
  observacion_interna?: string | null;
};
