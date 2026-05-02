import "server-only";

import { createHash } from "node:crypto";
import {
  mergeCustomTemplateFields,
  type SorteoTicketImageConfig,
} from "@/lib/sorteos/sorteo-ticket-types";
import {
  getSorteoTicketSvgEmbeddedFontCss,
  SORTEO_TICKET_FONT_FAMILY,
} from "@/lib/sorteos/sorteo-ticket-svg-font";

export type SorteoTicketRenderInput = {
  empresaNombre: string;
  sorteoNombre: string;
  clienteNombre?: string;
  documento?: string;
  telefono?: string;
  numeroOrden: string;
  cupones: string[];
  /** ISO o texto localizable */
  fechaHora: string;
  config: SorteoTicketImageConfig;
  /** bytes PNG/JPEG/WebP o null */
  logoBytes: Buffer | null;
  logoMime: string | null;
  backgroundBytes: Buffer | null;
  backgroundMime: string | null;
  /** Plantilla completa (custom_template) */
  templateBytes?: Buffer | null;
  templateMime?: string | null;
};

/** Canvas modo automático — comprobante vertical premium */
const WA = 1080;
const HA = 1350;
const PAD = 48;
const CARD_RX = 28;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return "?";
  if (p.length === 1) return p[0]!.slice(0, 2).toUpperCase();
  return (p[0]![0]! + p[p.length - 1]![0]!).toUpperCase();
}

function dataUrlFromBuffer(buf: Buffer, mime: string): string {
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

/** Cupón(es): tipografía grande, centrado en bloque */
function cuponesAutoSvg(
  cupones: string[],
  yStart: number,
  primary: string,
  accent: string
): string {
  const ff = SORTEO_TICKET_FONT_FAMILY;
  if (cupones.length === 0) {
    return `<text font-family="${ff}" x="${WA / 2}" y="${yStart}" text-anchor="middle" font-size="36" fill="${accent}">—</text>`;
  }
  if (cupones.length === 1) {
    return `<text font-family="${ff}" x="${WA / 2}" y="${yStart + 80}" text-anchor="middle" font-size="72" font-weight="800" letter-spacing="2" fill="${primary}">${esc(
      cupones[0]!
    )}</text>`;
  }
  const lines: string[] = [];
  let y = yStart;
  const fs = cupones.length <= 4 ? 56 : cupones.length <= 9 ? 40 : 32;
  const step = fs + 14;
  for (const c of cupones.slice(0, 24)) {
    lines.push(
      `<text font-family="${ff}" x="${WA / 2}" y="${y}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="${primary}">${esc(c)}</text>`
    );
    y += step;
  }
  if (cupones.length > 24) {
    lines.push(
      `<text font-family="${ff}" x="${WA / 2}" y="${y + 20}" text-anchor="middle" font-size="22" font-weight="600" fill="${accent}">+${cupones.length - 24} más</text>`
    );
  }
  return lines.join("\n");
}

/**
 * Modo automático: layout vertical 1080×1350, logo destacado, datos en “cards”, cupón protagonista.
 */
export function buildSorteoTicketSvg(input: SorteoTicketRenderInput): string {
  const cfg = input.config;
  const bg = (cfg.backgroundColor ?? "#f1f5f9").trim();
  const primary = (cfg.primaryColor ?? "#0f172a").trim();
  const secondary = (cfg.secondaryColor ?? "#64748b").trim();
  const accent = (cfg.primaryColor ?? "#4f46e5").trim();
  const title = (cfg.title ?? "Comprobante de participación").trim();
  const footer = (cfg.legalFooter ?? "").trim();

  const showLogo = cfg.showLogo !== false;
  const showNombre = cfg.showClienteNombre !== false;
  const showDoc = cfg.showDocumento !== false;
  const showTel = cfg.showTelefono !== false;
  const showOrd = cfg.showNumeroOrden !== false;
  const showCup = cfg.showCupones !== false;
  const showSorteoNom = cfg.showSorteoNombre !== false;

  let headerLogo = "";
  if (showLogo) {
    if (input.logoBytes && input.logoMime) {
      const href = dataUrlFromBuffer(input.logoBytes, input.logoMime);
      /** Logo ancho arriba */
      headerLogo = `<image href="${href}" x="${(WA - 200) / 2}" y="${PAD}" width="200" height="200" preserveAspectRatio="xMidYMid meet"/>`;
    } else {
      const ini = initials(input.clienteNombre || input.empresaNombre);
      headerLogo = `<rect x="${(WA - 200) / 2}" y="${PAD}" width="200" height="200" rx="24" fill="#e2e8f0"/>
        <text font-family="${SORTEO_TICKET_FONT_FAMILY}" x="${WA / 2}" y="${PAD + 120}" text-anchor="middle" font-size="64" font-weight="800" fill="#475569">${esc(ini)}</text>`;
    }
  }

  let bgPattern = "";
  if (input.backgroundBytes && input.backgroundMime) {
    const href = dataUrlFromBuffer(input.backgroundBytes, input.backgroundMime);
    bgPattern = `<image href="${href}" x="0" y="0" width="${WA}" height="${HA}" preserveAspectRatio="xMidYMid slice" opacity="0.12"/>`;
  }

  const yHeader = showLogo ? PAD + 220 : PAD + 20;
  const cardTop = yHeader + 28;
  const cardW = WA - PAD * 2;
  const cardX = PAD;

  const rows: { label: string; value: string }[] = [];
  if (showNombre && input.clienteNombre?.trim()) {
    rows.push({ label: "Participante", value: input.clienteNombre.trim() });
  }
  if (showDoc && input.documento?.trim()) {
    rows.push({ label: "Documento", value: input.documento.trim() });
  }
  if (showTel && input.telefono?.trim()) {
    rows.push({ label: "Teléfono", value: input.telefono.trim() });
  }
  if (showOrd && String(input.numeroOrden ?? "").trim()) {
    rows.push({ label: "Nº de orden", value: String(input.numeroOrden).trim() });
  }
  if (showSorteoNom && input.sorteoNombre?.trim()) {
    rows.push({ label: "Sorteo", value: input.sorteoNombre.trim() });
  }

  let rowY = cardTop + 56;
  const rowSvg = rows
    .map((r) => {
      const block = `<text x="${cardX + 36}" y="${rowY}" font-size="22" font-weight="600" fill="${secondary}">${esc(
        r.label
      )}</text>
      <text x="${cardX + 36}" y="${rowY + 28}" font-size="30" font-weight="700" fill="${primary}">${esc(r.value)}</text>`;
      rowY += 78;
      return block;
    })
    .join("\n");

  const cardH = Math.max(120 + rows.length * 78, 200);
  const cupY = cardTop + cardH + 80;
  const cupones = showCup ? input.cupones.filter((c) => String(c).trim()) : [];
  const cupSvg =
    cupones.length > 0
      ? `<text font-family="${SORTEO_TICKET_FONT_FAMILY}" x="${WA / 2}" y="${cupY}" text-anchor="middle" font-size="26" font-weight="700" fill="${accent}" letter-spacing="0.05em">CUPONES</text>
  ${cuponesAutoSvg(cupones, cupY + 40, primary, secondary)}`
      : "";

  const fontCss = getSorteoTicketSvgEmbeddedFontCss();
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WA}" height="${HA}" viewBox="0 0 ${WA} ${HA}">
  <defs>
    ${
      fontCss
        ? `<style type="text/css"><![CDATA[
${fontCss}
]]></style>`
        : ""
    }
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="${WA}" height="${HA}" fill="${bg}"/>
  ${bgPattern}
  ${headerLogo}
  <text font-family="${SORTEO_TICKET_FONT_FAMILY}" x="${WA / 2}" y="${yHeader}" text-anchor="middle" font-size="28" font-weight="700" fill="${secondary}">${esc(
    input.empresaNombre
  )}</text>
  <text font-family="${SORTEO_TICKET_FONT_FAMILY}" x="${WA / 2}" y="${yHeader + 42}" text-anchor="middle" font-size="40" font-weight="800" fill="${primary}">${esc(
    title
  )}</text>
  <rect x="${cardX}" y="${cardTop}" width="${cardW}" height="${cardH}" rx="${CARD_RX}" fill="#ffffff" filter="url(#cardShadow)"/>
  ${rowSvg}
  ${cupSvg}
  <text font-family="${SORTEO_TICKET_FONT_FAMILY}" x="${WA / 2}" y="${HA - PAD - (footer ? 56 : 28)}" text-anchor="middle" font-size="24" fill="${secondary}">${esc(
    input.fechaHora
  )}</text>
  ${
    footer
      ? `<text font-family="${SORTEO_TICKET_FONT_FAMILY}" x="${WA / 2}" y="${HA - PAD - 12}" text-anchor="middle" font-size="20" fill="${secondary}">${esc(footer)}</text>`
      : ""
  }
</svg>`;
}

function fillAttr(color: string): string {
  const t = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(t) || /^#[0-9A-Fa-f]{3}$/.test(t)) return t;
  return "#111827";
}

/**
 * Datos en la parte inferior; cupones protagonistas. Colores desde mergeCustomTemplateFields.
 * 1–6 cupones: apilados centrados, tipografía grande. Más de 6: grilla compacta.
 */
function buildCustomTemplateOverlaySvg(
  w: number,
  h: number,
  input: SorteoTicketRenderInput,
  layout: ReturnType<typeof mergeCustomTemplateFields>
): string {
  const padX = Math.max(40, Math.min(layout.cliente_nombre?.x ?? 72, w * 0.2));
  const fontCss = getSorteoTicketSvgEmbeddedFontCss();
  const ff = SORTEO_TICKET_FONT_FAMILY;
  const bottomPad = Math.max(36, Math.round(h * 0.028));
  const zoneTopLimit = Math.round(h * 0.33);

  const colName = fillAttr(layout.cliente_nombre.color);
  const colDoc = fillAttr(layout.cliente_documento.color);
  const colTel = fillAttr(layout.telefono.color);
  const colOrd = fillAttr(layout.numero_orden.color);
  const colSort = fillAttr(layout.sorteo_nombre.color);
  const colCup = fillAttr(layout.cupones.color);

  const cupones = input.cupones ?? [];
  const metaGap = 10;
  const blockGap = 20;

  type MetaRow = { text: string; fs: number; color: string; weight: number };
  const buildMetaRows = (scale: number): MetaRow[] => {
    const r = (n: number) => Math.max(14, Math.round(n * scale));
    const rows: MetaRow[] = [];
    const cn = input.clienteNombre?.trim();
    if (cn) {
      rows.push({
        text: cn,
        fs: r(Math.max(layout.cliente_nombre.fontSize, 26)),
        color: colName,
        weight: 700,
      });
    }
    const doc = input.documento?.trim();
    if (doc) {
      rows.push({
        text: `Documento: ${doc}`,
        fs: r(Math.max(layout.cliente_documento.fontSize, 22)),
        color: colDoc,
        weight: 600,
      });
    }
    const tel = input.telefono?.trim();
    if (tel) {
      rows.push({
        text: `Teléfono: ${tel}`,
        fs: r(Math.max(layout.telefono.fontSize, 22)),
        color: colTel,
        weight: 600,
      });
    }
    const ord = String(input.numeroOrden ?? "").trim();
    if (ord) {
      rows.push({
        text: `Nº orden: ${ord}`,
        fs: r(Math.max(layout.numero_orden.fontSize, 28)),
        color: colOrd,
        weight: 700,
      });
    }
    const sn = input.sorteoNombre?.trim();
    if (sn) {
      rows.push({
        text: `Sorteo: ${sn}`,
        fs: r(Math.max(layout.sorteo_nombre.fontSize, 22)),
        color: colSort,
        weight: 600,
      });
    }
    return rows;
  };

  const metaLineH = (rows: MetaRow[]) => {
    let sum = 0;
    for (const row of rows) {
      sum += row.fs + metaGap;
    }
    return sum - metaGap;
  };

  const cupBlockHeight = (scale: number): number => {
    const n = cupones.length;
    if (n === 0) return Math.round(36 * scale);
    if (n <= 6) {
      const fs = Math.min(
        72,
        Math.max(46, Math.round((layout.cupones.fontSize + (6 - Math.min(n, 6)) * 2) * scale))
      );
      const step = Math.round(fs * 1.2);
      return n * step + 8;
    }
    const cols = 3;
    const cap = Math.min(n, 24);
    const rowsN = Math.ceil(cap / cols);
    return rowsN * 34 + 36;
  };

  let scale = 1;
  let metaRows = buildMetaRows(scale);
  let totalH = metaLineH(metaRows) + blockGap + cupBlockHeight(scale);
  let yStart = h - bottomPad - totalH;

  for (let i = 0; i < 14 && yStart < zoneTopLimit && scale > 0.62; i++) {
    scale *= 0.9;
    metaRows = buildMetaRows(scale);
    totalH = metaLineH(metaRows) + blockGap + cupBlockHeight(scale);
    yStart = h - bottomPad - totalH;
  }

  const pieces: string[] = [];
  let y = yStart;
  for (const row of metaRows) {
    y += row.fs;
    pieces.push(
      `<text x="${padX}" y="${y}" font-family="${ff}" font-size="${row.fs}" font-weight="${row.weight}" fill="${fillAttr(row.color)}">${esc(row.text)}</text>`
    );
    y += metaGap;
  }
  y += blockGap - metaGap;

  const cx = w / 2;
  if (cupones.length === 0) {
    /* Sin cupones resueltos: no dibujar placeholder */
  } else if (cupones.length <= 6) {
    const fs = Math.min(
      84,
      Math.max(
        52,
        Math.round((layout.cupones.fontSize + (6 - Math.min(cupones.length, 6)) * 3) * scale)
      )
    );
    const step = Math.round(fs * 1.2);
    for (let i = 0; i < cupones.length; i++) {
      y += step;
      pieces.push(
        `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${ff}" font-size="${fs}" font-weight="800" letter-spacing="0.02em" fill="${colCup}">${esc(cupones[i]!)}</text>`
      );
    }
  } else {
    const cols = 3;
    const cellW = (w - 2 * padX) / cols;
    const fs = Math.round(22 * scale);
    const rowH = 34;
    const maxShow = 24;
    const list = cupones.slice(0, maxShow);
    let gy = y + fs + 4;
    for (let i = 0; i < list.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const xCell = padX + col * cellW + cellW / 2;
      const yCell = gy + row * rowH;
      pieces.push(
        `<text x="${xCell}" y="${yCell}" text-anchor="middle" font-family="${ff}" font-size="${fs}" font-weight="700" fill="${colCup}">${esc(list[i]!)}</text>`
      );
    }
    if (cupones.length > maxShow) {
      gy += Math.ceil(list.length / cols) * rowH + 8;
      pieces.push(
        `<text x="${cx}" y="${gy}" text-anchor="middle" font-family="${ff}" font-size="${Math.round(18 * scale)}" font-weight="600" fill="${colCup}">+${cupones.length - maxShow} más</text>`
      );
    }
  }

  const defs =
    fontCss.length > 0
      ? `<defs><style type="text/css"><![CDATA[
${fontCss}
]]></style></defs>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${defs}
  ${pieces.join("\n")}
</svg>`;
}

async function renderCustomTemplateTicketPng(input: SorteoTicketRenderInput): Promise<Buffer> {
  const buf = input.templateBytes!;
  const sharpMod = (await import("sharp")).default;
  const meta = await sharpMod(buf).metadata();
  const w = meta.width && meta.width > 0 ? meta.width : input.config.custom_template_width ?? 1080;
  const h = meta.height && meta.height > 0 ? meta.height : input.config.custom_template_height ?? 1350;

  const fields = mergeCustomTemplateFields(input.config);
  const overlaySvg = buildCustomTemplateOverlaySvg(w, h, input, fields);
  const overlayPng = await sharpMod(Buffer.from(overlaySvg, "utf8")).png().toBuffer();

  const baseRgb = await sharpMod(buf)
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();

  return sharpMod(baseRgb)
    .composite([{ input: overlayPng, left: 0, top: 0, blend: "over" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function renderSorteoTicketPng(svg: string): Promise<{ png: Buffer; hash: string }> {
  const sharpMod = (await import("sharp")).default;
  const png = await sharpMod(Buffer.from(svg, "utf8")).png({ compressionLevel: 9 }).toBuffer();
  const hash = createHash("sha256").update(png).digest("hex");
  return { png, hash };
}

/**
 * Punto único: plantilla personalizada (imagen + texto) o automático (SVG premium).
 */
export async function renderTicketPngUnified(input: SorteoTicketRenderInput): Promise<{ png: Buffer; hash: string }> {
  const hasTemplate =
    input.templateBytes && input.templateBytes.length > 0 && input.templateMime;
  if (hasTemplate) {
    try {
      const png = await renderCustomTemplateTicketPng(input);
      const hash = createHash("sha256").update(png).digest("hex");
      return { png, hash };
    } catch (e) {
      console.warn("[sorteo-ticket-render] custom_template_failed_fallback_auto", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const svg = buildSorteoTicketSvg(input);
  return renderSorteoTicketPng(svg);
}
