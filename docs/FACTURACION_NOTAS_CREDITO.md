# Notas de crédito — Fase 1 (implementado)

## Alcance

- Modelo de datos en el schema de datos de la empresa (`zentra_erp` o `erp_*` vía `empresa.data_schema`).
- Creación de NC en estado **borrador** con monto = **saldo pendiente** al momento de crear.
- Registro de fila en **nota_credito_electronica** en estado SIFEN `sin_envio` (sin XML/envío en esta fase).
- **Auditoría** en `nota_credito_evento` (creación, validación, anulación de borrador).
- UI en detalle de factura: bloque **Corrección fiscal**, historial y modal de alta.
- **No** se modifica el saldo de la factura al crear el borrador (solo cuando exista flujo de aprobación SIFEN en fases posteriores).

## Reglas de prioridad

Si el DE está **aprobado** y aún **puede cancelarse** dentro del plazo configurado (y sin pagos, etc.), el sistema **rechaza** crear una NC (`409`) y la UI prioriza la cancelación.

## Tablas

| Tabla | Rol |
|-------|-----|
| `nota_credito` | Cabecera comercial + snapshots + estado ERP |
| `nota_credito_electronica` | Ciclo de vida del DE de la NC (preparado para fase SIFEN) |
| `nota_credito_evento` | Auditoría / eventos de negocio |

## API

Ver `docs/API.md` — sección facturas / notas-credito.
