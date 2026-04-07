/**
 * KuDE PDF — representación gráfica del DE (pdf-lib, Vercel-safe).
 * Estilo factura PY; acento Neura #0EA5E9; textos en negro.
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFImage, type PDFPage, type PDFFont, type RGB } from "pdf-lib";
import QRCode from "qrcode";
import type { KudeItemRow, KudeParsedFromXml } from "./parse-kude-from-signed-xml";

export type BuildKudePdfInput = {
  parsed: KudeParsedFromXml;
  numeroFactura: string;
  dProtAut: string | null;
  qrUrl: string;
};

const A4_W = 595.28;
const A4_H = 841.89;
const NEURA_BLUE: RGB = rgb(14 / 255, 165 / 255, 233 / 255);
const NEURA_BLUE_FILL: RGB = rgb(0.93, 0.97, 1);
const BLACK: RGB = rgb(0, 0, 0);
const GRAY: RGB = rgb(0.35, 0.35, 0.35);

/** Distancia desde el borde superior de la página hasta la línea base del texto (pt). */
function baselineFromTop(page: PDFPage, fromTop: number): number {
  return page.getHeight() - fromTop;
}

function drawRectFromTop(
  page: PDFPage,
  left: number,
  fromTop: number,
  width: number,
  height: number,
  opts: { border?: RGB; borderW?: number; fill?: RGB }
) {
  page.drawRectangle({
    x: left,
    y: page.getHeight() - (fromTop + height),
    width,
    height,
    borderColor: opts.border ?? NEURA_BLUE,
    borderWidth: opts.borderW ?? 0.75,
    color: opts.fill,
  });
}

function formatMonto(nStr: string, moneda: string): string {
  const n = Number.parseFloat(String(nStr).replace(",", "."));
  if (!Number.isFinite(n)) return String(nStr);
  if (moneda === "PYG" || moneda === "GS") {
    return Math.round(n).toLocaleString("es-PY");
  }
  return n.toLocaleString("es-PY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function readLogoBytes(): Uint8Array | null {
  const p = path.join(process.cwd(), "public", "logo-neura.png");
  try {
    if (fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));
  } catch {
    /* ignore */
  }
  return null;
}

function trunc(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** Alinea el texto al borde derecho `rightX` (coordenada x del final del trazo). */
function drawTextRight(
  page: PDFPage,
  text: string,
  rightX: number,
  fromTop: number,
  size: number,
  font: PDFFont,
  color: RGB
) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: rightX - w,
    y: baselineFromTop(page, fromTop),
    size,
    font,
    color,
  });
}

/** Parte texto por ancho máximo aproximado (caracteres) para no invadir columna derecha. */
function wrapByChars(text: string, maxChars: number): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > 0) {
    if (rest.length <= maxChars) {
      out.push(rest);
      break;
    }
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return out.filter(Boolean);
}

function drawTableChunk(
  page: PDFPage,
  items: KudeItemRow[],
  parsed: KudeParsedFromXml,
  margin: number,
  innerW: number,
  fromTop: number,
  font: PDFFont,
  fontBold: PDFFont
): number {
  const fsz = 6.5;
  const headH = 16;
  const rowH = 11;
  const bodyH = Math.max(14, items.length * rowH + 8);
  const totalH = headH + bodyH;

  drawRectFromTop(page, margin, fromTop, innerW, totalH, { fill: rgb(1, 1, 1), border: NEURA_BLUE });
  drawRectFromTop(page, margin, fromTop, innerW, headH, { fill: NEURA_BLUE_FILL, border: NEURA_BLUE });

  const xCod = margin + 4;
  const xDesc = margin + 36;
  const xUm = margin + 186;
  const xPr = margin + 228;
  const xCan = margin + 282;
  const xEx = margin + 316;
  const x5 = margin + 366;
  const x10 = margin + 414;
  let headerBaseline = fromTop + 11;

  const drawH = (txt: string, x: number, bold: boolean) => {
    page.drawText(txt, {
      x,
      y: baselineFromTop(page, headerBaseline),
      size: fsz,
      font: bold ? fontBold : font,
      color: bold ? NEURA_BLUE : BLACK,
    });
  };
  drawH("Código", xCod, true);
  drawH("Descripción", xDesc, true);
  drawH("Unidad", xUm, true);
  drawH("Precio", xPr, true);
  drawH("Cant.", xCan, true);
  drawH("Exentas", xEx, true);
  drawH("5%", x5, true);
  drawH("10%", x10, true);

  let rowBaseline = fromTop + headH + 9;
  for (const row of items) {
    const yb = baselineFromTop(page, rowBaseline);
    page.drawText(trunc(row.codigo, 10), { x: xCod, y: yb, size: fsz, font, color: BLACK });
    page.drawText(trunc(row.descripcion, 40), { x: xDesc, y: yb, size: fsz, font, color: BLACK });
    page.drawText(trunc(row.unidadMedida, 8), { x: xUm, y: yb, size: fsz, font, color: BLACK });
    page.drawText(formatMonto(row.precioUnit, parsed.monedaCodigo), { x: xPr, y: yb, size: fsz, font, color: BLACK });
    page.drawText(row.cantidad || "—", { x: xCan, y: yb, size: fsz, font, color: BLACK });
    page.drawText(formatMonto(row.montoExenta, parsed.monedaCodigo), { x: xEx, y: yb, size: fsz, font, color: BLACK });
    page.drawText(formatMonto(row.montoGrav5, parsed.monedaCodigo), { x: x5, y: yb, size: fsz, font, color: BLACK });
    page.drawText(formatMonto(row.montoGrav10, parsed.monedaCodigo), { x: x10, y: yb, size: fsz, font, color: BLACK });
    rowBaseline += rowH;
  }

  return fromTop + totalH + 10;
}

export async function buildKudePdfBuffer(input: BuildKudePdfInput): Promise<Buffer> {
  const { parsed, numeroFactura, dProtAut, qrUrl } = input;

  const qrPng = await QRCode.toBuffer(qrUrl, {
    type: "png",
    width: 168,
    margin: 1,
    errorCorrectionLevel: "M",
  });

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`KuDE — Factura ${numeroFactura}`);
  pdfDoc.setAuthor("Neura ERP");

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const margin = 36;
  const innerW = A4_W - margin * 2;
  const rightEdge = margin + innerW - 8;
  /** Columna izquierda del encabezado: no escribir más allá de esta x para no chocar con la derecha. */
  const headerSplitX = margin + innerW * 0.52;
  let page = pdfDoc.addPage([A4_W, A4_H]);

  const nroTimbrado = `${parsed.timbrado.dEst}-${parsed.timbrado.dPunExp}-${parsed.timbrado.dNumDoc}`;
  const rucEmisor = `${parsed.emisor.dRucEm}-${parsed.emisor.dDVEmi}`;
  const tipoCambio =
    parsed.monedaCodigo === "PYG" || parsed.monedaCodigo === "GS"
      ? "1,00 (moneda local)"
      : "Ver documento electrónico";

  let cursorTop = margin;

  /* ── Header: medir → marco → logo + emisor (ancho limitado) + factura a la derecha ── */
  const headerPad = 12;
  const logoMaxW = 72;
  let logoH = 0;
  let logoW = 0;
  let logoImg: PDFImage | null = null;
  const logoBytes = readLogoBytes();
  if (logoBytes) {
    try {
      logoImg = await pdfDoc.embedPng(logoBytes);
      logoW = logoMaxW;
      const sc = logoW / logoImg.width;
      logoH = logoImg.height * sc;
    } catch {
      logoH = 0;
      logoW = 0;
      logoImg = null;
    }
  }

  const leftTextX = margin + headerPad + (logoW > 0 ? logoW + 12 : 0);
  const leftMaxChars = Math.max(28, Math.floor((headerSplitX - leftTextX) / 4.2));

  const leftChunks: { lines: string[]; size: number; bold: boolean; col: RGB }[] = [
    { lines: wrapByChars(parsed.emisor.dNomEmi, leftMaxChars), size: 9, bold: true, col: BLACK },
    { lines: wrapByChars(parsed.emisor.dDirEmi, leftMaxChars), size: 7.5, bold: false, col: BLACK },
    {
      lines: wrapByChars(
        `Tel.: ${parsed.emisor.dTelEmi}  |  Email: ${parsed.emisor.dEmailE}`,
        leftMaxChars
      ),
      size: 7.5,
      bold: false,
      col: BLACK,
    },
    { lines: [`RUC: ${rucEmisor}`], size: 8.5, bold: true, col: BLACK },
    { lines: [`Timbrado Nº: ${parsed.timbrado.dNumTim}`], size: 7.5, bold: false, col: BLACK },
    { lines: [`Vigencia desde: ${parsed.timbrado.dFeIniT}`], size: 7.5, bold: false, col: BLACK },
  ];

  const rightLeadTitle = 13;
  const rightLead = 11;
  let leftBottom = cursorTop + headerPad + 9;
  for (const ch of leftChunks) {
    const lead = ch.size + 3;
    leftBottom += ch.lines.length * lead;
  }
  const rightBottom = cursorTop + headerPad + 11 + rightLeadTitle + rightLead + rightLead;
  const logoBottom = cursorTop + headerPad + logoH;
  const headerBottom = Math.max(leftBottom, rightBottom, logoBottom) + 10;
  const headerH = headerBottom - cursorTop;

  drawRectFromTop(page, margin, cursorTop, innerW, headerH, { fill: rgb(1, 1, 1), border: NEURA_BLUE });

  if (logoImg && logoW > 0) {
    page.drawImage(logoImg, {
      x: margin + headerPad,
      y: baselineFromTop(page, cursorTop + headerPad + logoH),
      width: logoW,
      height: logoH,
    });
  }

  let leftBaseline = cursorTop + headerPad + 9;
  for (const ch of leftChunks) {
    const f = ch.bold ? fontBold : font;
    const lead = ch.size + 3;
    for (const ln of ch.lines) {
      page.drawText(ln, {
        x: leftTextX,
        y: baselineFromTop(page, leftBaseline),
        size: ch.size,
        font: f,
        color: ch.col,
      });
      leftBaseline += lead;
    }
  }

  let rightBaseline = cursorTop + headerPad + 11;
  drawTextRight(page, "Factura electrónica", rightEdge, rightBaseline, 10, fontBold, NEURA_BLUE);
  rightBaseline += rightLeadTitle;
  drawTextRight(page, `Nº: ${nroTimbrado}`, rightEdge, rightBaseline, 9, font, BLACK);
  rightBaseline += rightLead;
  drawTextRight(page, `Ref. ERP: ${numeroFactura}`, rightEdge, rightBaseline, 7.5, font, GRAY);

  cursorTop += headerH + 10;

  const sectionTitle = (title: string) => {
    page.drawText(title, {
      x: margin,
      y: baselineFromTop(page, cursorTop + 9),
      size: 9,
      font: fontBold,
      color: NEURA_BLUE,
    });
    cursorTop += 13;
  };

  /* Operación */
  sectionTitle("DATOS DE LA OPERACIÓN");
  const opH = 62;
  drawRectFromTop(page, margin, cursorTop, innerW, opH, { fill: rgb(1, 1, 1), border: NEURA_BLUE });
  let lo = cursorTop + 11;
  const opLines = [
    `Fecha de emisión: ${parsed.dFeEmiDE}`,
    `Condición de venta: ${parsed.operacion.condicionVenta}`,
    `Moneda: ${parsed.monedaDescripcion || parsed.monedaCodigo} (${parsed.monedaCodigo})`,
    `Tipo de cambio: ${tipoCambio}`,
    `Tipo de operación: ${parsed.operacion.tipoOperacion}`,
  ];
  for (const s of opLines) {
    page.drawText(s, {
      x: margin + 10,
      y: baselineFromTop(page, lo),
      size: 8,
      font,
      color: BLACK,
    });
    lo += 11;
  }
  cursorTop += opH + 10;

  /* Cliente */
  sectionTitle("DATOS DEL CLIENTE");
  const cliH = 62;
  drawRectFromTop(page, margin, cursorTop, innerW, cliH, { fill: rgb(1, 1, 1), border: NEURA_BLUE });
  let lc = cursorTop + 11;
  const cliDraw = (s: string, sz: number, bold: boolean) => {
    page.drawText(s, {
      x: margin + 10,
      y: baselineFromTop(page, lc),
      size: sz,
      font: bold ? fontBold : font,
      color: BLACK,
    });
    lc += bold ? 12 : 11;
  };
  cliDraw(`${parsed.receptor.docLabel}: ${parsed.receptor.docValue}`, 8, false);
  cliDraw(trunc(parsed.receptor.nombre, 72), 9, true);
  cliDraw(`Dirección: ${parsed.receptor.direccion || "—"}`, 8, false);
  cliDraw(`Teléfono: ${parsed.receptor.telefono || "—"}`, 8, false);
  cursorTop += cliH + 10;

  /* Tabla */
  sectionTitle("DETALLE DE LA MERCADERÍA / SERVICIOS");
  const footerReserve = 200;
  const rowH = 11;
  const headH = 16;
  let idx = 0;
  const items = parsed.items;
  while (idx < items.length) {
    let room = A4_H - cursorTop - footerReserve;
    if (room < headH + rowH + 20) {
      page = pdfDoc.addPage([A4_W, A4_H]);
      cursorTop = margin;
      room = A4_H - cursorTop - footerReserve;
    }
    const maxRows = Math.max(1, Math.floor((room - headH - 12) / rowH));
    const slice = items.slice(idx, idx + maxRows);
    if (slice.length === 0) {
      page = pdfDoc.addPage([A4_W, A4_H]);
      cursorTop = margin;
      continue;
    }
    cursorTop = drawTableChunk(page, slice, parsed, margin, innerW, cursorTop, font, fontBold);
    idx += slice.length;
    if (idx < items.length) {
      page = pdfDoc.addPage([A4_W, A4_H]);
      cursorTop = margin;
      page.drawText("(Continúa detalle)", {
        x: margin,
        y: baselineFromTop(page, cursorTop + 8),
        size: 8,
        font,
        color: GRAY,
      });
      cursorTop += 16;
    }
  }

  /* Totales */
  if (A4_H - cursorTop < 160) {
    page = pdfDoc.addPage([A4_W, A4_H]);
    cursorTop = margin;
  }
  sectionTitle("TOTALES Y LIQUIDACIÓN DEL IVA");
  const totH = 140;
  drawRectFromTop(page, margin, cursorTop, innerW, totH, { fill: rgb(1, 1, 1), border: NEURA_BLUE });

  const xL = margin + 10;
  const xR = margin + innerW * 0.5;
  let lt = cursorTop + 12;
  const putL = (a: string, b: string, useBoldValue: boolean) => {
    page.drawText(a, { x: xL, y: baselineFromTop(page, lt), size: 8, font, color: BLACK });
    page.drawText(b, {
      x: xL + 128,
      y: baselineFromTop(page, lt),
      size: 8,
      font: useBoldValue ? fontBold : font,
      color: BLACK,
    });
    lt += 11;
  };
  putL("Subtotal exentas:", formatMonto(parsed.totales.dSubExe, parsed.monedaCodigo), true);
  putL("Subtotal gravadas 5%:", formatMonto(parsed.totales.dSub5, parsed.monedaCodigo), true);
  putL("Subtotal gravadas 10%:", formatMonto(parsed.totales.dSub10, parsed.monedaCodigo), true);
  lt += 4;
  page.drawLine({
    start: { x: margin + 6, y: baselineFromTop(page, lt) },
    end: { x: margin + innerW * 0.46, y: baselineFromTop(page, lt) },
    thickness: 0.45,
    color: NEURA_BLUE,
  });
  lt += 10;
  page.drawText("Total de la operación:", {
    x: xL,
    y: baselineFromTop(page, lt),
    size: 9,
    font: fontBold,
    color: BLACK,
  });
  page.drawText(formatMonto(parsed.totales.dTotOpe, parsed.monedaCodigo), {
    x: xL + 138,
    y: baselineFromTop(page, lt),
    size: 9,
    font: fontBold,
    color: BLACK,
  });
  lt += 13;
  putL("Total en guaraníes:", formatMonto(parsed.totales.dTotGralOpe, parsed.monedaCodigo), true);

  let rt = cursorTop + 12;
  page.drawText("Liquidación IVA", {
    x: xR,
    y: baselineFromTop(page, rt),
    size: 9,
    font: fontBold,
    color: NEURA_BLUE,
  });
  rt += 13;
  const putIvaLine = (lab: string, val: string) => {
    page.drawText(lab, { x: xR, y: baselineFromTop(page, rt), size: 8, font, color: BLACK });
    page.drawText(val, {
      x: xR + 104,
      y: baselineFromTop(page, rt),
      size: 8,
      font: fontBold,
      color: BLACK,
    });
    rt += 11;
  };
  putIvaLine("Base gravada 5%:", formatMonto(parsed.totales.dBaseGrav5, parsed.monedaCodigo));
  putIvaLine("IVA 5%:", formatMonto(parsed.totales.dIVA5, parsed.monedaCodigo));
  putIvaLine("Base gravada 10%:", formatMonto(parsed.totales.dBaseGrav10, parsed.monedaCodigo));
  putIvaLine("IVA 10%:", formatMonto(parsed.totales.dIVA10, parsed.monedaCodigo));
  rt += 5;
  page.drawLine({
    start: { x: xR - 2, y: baselineFromTop(page, rt) },
    end: { x: rightEdge, y: baselineFromTop(page, rt) },
    thickness: 0.5,
    color: NEURA_BLUE,
  });
  rt += 10;
  page.drawText("Total IVA:", {
    x: xR,
    y: baselineFromTop(page, rt),
    size: 9,
    font: fontBold,
    color: BLACK,
  });
  page.drawText(formatMonto(parsed.totales.dTotIVA, parsed.monedaCodigo), {
    x: xR + 104,
    y: baselineFromTop(page, rt),
    size: 9,
    font: fontBold,
    color: BLACK,
  });

  cursorTop += totH + 12;

  /* Pie: fila 1 = QR (izq) + textos (der); fila 2 = leyendas ancho completo debajo del QR */
  if (A4_H - cursorTop < 185) {
    page = pdfDoc.addPage([A4_W, A4_H]);
    cursorTop = margin;
  }

  const qrImg = await pdfDoc.embedPng(new Uint8Array(qrPng));
  const qSz = 90;
  const footPad = 14;
  const gapAfterQr = 14;
  const legendSize = 6.5;
  const legendLead = 9;

  const cdcLines = wrapByChars(`CDC: ${parsed.cdc}`, 52);
  const footTextW = innerW - footPad * 2 - qSz - 16;
  const footTextX = margin + footPad + qSz + 14;

  let footTextBaseline = cursorTop + footPad + 9;
  const textBlockLines =
    1 +
    cdcLines.length +
    (dProtAut ? 1 : 0) +
    wrapByChars("Escanee el código QR o consulte el CDC en el portal e-kuatia.", Math.max(30, Math.floor(footTextW / 3.4)))
      .length;
  const textBlockHeight = textBlockLines * 10 + 6;
  const legendBlockHeight = legendLead * 3 + 8;
  const footBoxH = footPad + Math.max(qSz, textBlockHeight) + gapAfterQr + legendBlockHeight + footPad;

  drawRectFromTop(page, margin, cursorTop, innerW, footBoxH, { fill: rgb(1, 1, 1), border: NEURA_BLUE });

  page.drawImage(qrImg, {
    x: margin + footPad,
    y: baselineFromTop(page, cursorTop + footPad + qSz),
    width: qSz,
    height: qSz,
  });

  page.drawText("Consulta de validez (e-kuatia / SET)", {
    x: footTextX,
    y: baselineFromTop(page, footTextBaseline),
    size: 8,
    font: fontBold,
    color: NEURA_BLUE,
  });
  footTextBaseline += 12;
  for (const line of cdcLines) {
    page.drawText(line, {
      x: footTextX,
      y: baselineFromTop(page, footTextBaseline),
      size: 7.5,
      font,
      color: BLACK,
    });
    footTextBaseline += 10;
  }
  if (dProtAut) {
    for (const line of wrapByChars(`dProtAut: ${dProtAut}`, 52)) {
      page.drawText(line, {
        x: footTextX,
        y: baselineFromTop(page, footTextBaseline),
        size: 7.5,
        font,
        color: BLACK,
      });
      footTextBaseline += 10;
    }
  }
  for (const line of wrapByChars(
    "Escanee el código QR o consulte el CDC en el portal e-kuatia.",
    Math.max(30, Math.floor(footTextW / 3.4))
  )) {
    page.drawText(line, {
      x: footTextX,
      y: baselineFromTop(page, footTextBaseline),
      size: 7,
      font,
      color: GRAY,
    });
    footTextBaseline += 9;
  }

  const legendTop = cursorTop + footPad + qSz + gapAfterQr;
  let leg = legendTop + 8;
  const leg1 =
    "ESTE DOCUMENTO ES UNA REPRESENTACIÓN GRÁFICA DE UN DOCUMENTO ELECTRÓNICO (XML)";
  for (const line of wrapByChars(leg1, 78)) {
    page.drawText(line, {
      x: margin + footPad,
      y: baselineFromTop(page, leg),
      size: legendSize,
      font: fontBold,
      color: NEURA_BLUE,
    });
    leg += legendLead;
  }
  leg += 2;
  page.drawText("Generado con Neura ERP", {
    x: margin + footPad,
    y: baselineFromTop(page, leg),
    size: 6.5,
    font,
    color: GRAY,
  });

  return Buffer.from(await pdfDoc.save());
}
