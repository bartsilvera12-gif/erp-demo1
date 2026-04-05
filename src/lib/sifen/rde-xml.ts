/**
 * Generación de XML rDE (SIFEN / e-kuatia) formato 150 — Factura electrónica (iTiDE=1).
 * Namespace oficial: http://ekuatia.set.gov.py/sifen/xsd
 *
 * Salida: rDE > dVerFor + DE (sin Signature ni gCamFuFD; esos se completan al firmar).
 * Referencia estructural: pysifen/de/samples/v150/factura_electronica.xml (kmee/sifen).
 */
import { createHash } from "node:crypto";
import type { AmbienteSifen, SifenFacturaPayloadBase } from "./types";
import {
  SIFEN_TEST_CSC_GENERICO,
  SIFEN_TEST_LITERAL_DOCUMENTO,
} from "./sifen-ambiente-test";
import { SIFEN_EKUATIA_TARGET_NS, SIFEN_SIRECEP_DE_V150_XSD_FILE } from "./sifen-xsi-schema-location";
import { escapeXml } from "./xml";
import {
  fechaEmisionCdc,
  generarCdcFacturaElectronica,
  normalizarNumeroDocumentoSifen,
  normalizarNumeroTimbrado,
  normalizarCodigoTres,
  padDigits,
  splitRucParaXml,
} from "./sifen-cdc";

const NS = SIFEN_EKUATIA_TARGET_NS;
const XMLNS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
/** Par namespace + archivo relativo (sin https): SET TEST acepta esto; URL absoluta al .xsd provoca 0160. */
const RDE_XSI_SCHEMA_LOCATION = `${NS} ${SIFEN_SIRECEP_DE_V150_XSD_FILE}`;

/** Enumeraciones / literales exactos según DE_Types_v150.xsd (y catálogos referidos). */
const XSD_DES_TI_DE_FACTURA = "Factura electrónica";
const XSD_DES_TIP_TRA_VENTA_MERC = "Venta de mercadería";
const XSD_DES_IND_PRES_PRESENCIAL = "Operación presencial";
const XSD_DES_T_IMP_IVA = "IVA";
const XSD_DES_MONE_PYG = "Guarani";
const XSD_DES_AFEC_EXENTO = "Exento";
const XSD_DES_AFEC_GRAVADO = "Gravado IVA";
const XSD_DES_DOC_CI_PY = "Cédula paraguaya";
const XSD_DES_UNI_MED = "UNI";
const XSD_D_COND_CRED_PLAZO = "Plazo";

function textEl(name: string, value: string | number): string {
  const c = escapeXml(String(value));
  return `<${name}>${c}</${name}>`;
}

/** Monto en guaraníes: entero sin separadores. */
function montoGs(n: number): string {
  return String(Math.round(Number.isFinite(n) ? n : 0));
}

/** `tgTotSub.dRedon` — tipo `tdCRed` (decimal, hasta 4 decimales). */
function montoRedondeo(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v.toFixed(4);
}

function formatDeDateTime(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * `dFeEmiDE` / `dFecFirma` deben usar la **misma fecha calendario** que entra en el CDC (`fechaEmisionCdc(documento.fecha)`).
 * Si se usa solo `new Date()` al generar el XML días después, el Id (CDC) y la fecha en el DE quedan desalineados y SET rechaza el documento.
 */
function dFeEmiDeYFecFirma(fechaFacturaIso: string, horaReferencia: Date): string {
  const t = fechaFacturaIso.trim();
  const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const p = (x: number) => String(x).padStart(2, "0");
  if (dm) {
    const y = dm[1]!;
    const mo = dm[2]!;
    const d = dm[3]!;
    return `${y}-${mo}-${d}T${p(horaReferencia.getHours())}:${p(horaReferencia.getMinutes())}:${p(horaReferencia.getSeconds())}`;
  }
  return formatDeDateTime(horaReferencia);
}

function inferirTasaIva(subtotal: number, iva: number): 0 | 5 | 10 {
  if (!(subtotal > 0) || iva <= 0) return 0;
  const p = Math.round((100 * iva) / subtotal);
  if (Math.abs(p - 10) <= 1) return 10;
  if (Math.abs(p - 5) <= 1) return 5;
  return 10;
}

/** `tdDesAfecIVA`: solo coinciden textos fijos del XSD (la tasa va en `dTasaIVA`). */
function descripcionAfectacion(tasa: 0 | 5 | 10): string {
  if (tasa === 0) return XSD_DES_AFEC_EXENTO;
  return XSD_DES_AFEC_GRAVADO;
}

/**
 * `tiTipCont` / `iTiContRec`: 1 = persona física, 2 = persona jurídica (Manual Técnico SIFEN).
 * El XSD no incluye `dDes` para estos códigos en `gEmis` / `gDatRec`.
 * Heurística: forma societaria típica en denominación (PY) → jurídica; si no coincide → física.
 */
function esPersonaJuridicaSegunDenominacion(denominacion: string): boolean {
  const u = denominacion.trim().toUpperCase();
  if (!u) return false;
  if (/\bS\.?\s*A\.?\b/.test(u)) return true;
  if (/\bS\.?\s*R\.?\s*L\.?\b/.test(u)) return true;
  if (/\bE\.?\s*A\.?\s*S\.?\b/.test(u)) return true;
  if (/\bEAS\b/.test(u)) return true;
  if (/\bLTDA\b/.test(u)) return true;
  if (/\bS\.\s*EN\s*C\.?\b/.test(u) || /\bS\s+EN\s+C\b/.test(u)) return true;
  if (/\bUNIPERSONAL\b/.test(u)) return true;
  if (/\bCOOP(?:ERATIVA)?\b/.test(u)) return true;
  if (/\bY\s+CIA\b/.test(u)) return true;
  return false;
}

function iTipContCodigo(denominacion: string): "1" | "2" {
  return esPersonaJuridicaSegunDenominacion(denominacion) ? "2" : "1";
}

function dCodSegNueveDigitos(csc: string, semilla: string): string {
  const h = createHash("sha256")
    .update(`${csc.trim()}|${semilla}`)
    .digest();
  let s = "";
  for (let i = 0; i < h.length && s.length < 9; i++) {
    s += String(h[i]! % 10);
  }
  return s.padStart(9, "0").slice(-9);
}

export interface BuildRdeXmlOptions {
  /** Vigencia timbrado inicio YYYY-MM-DD → `gTimb.dFeIniT` (v150 no incluye `dFeFinT` en el XSD). */
  timbradoFechaInicio: string;
  /** @deprecated v150: no se emite `dFeFinT` (no está en tgDTim del XSD; SET rechaza el nodo). */
  timbradoFechaFin?: string;
  /** Ambiente SIFEN de la empresa: en `test` aplican literales y CSC genérico del DE. */
  ambiente?: AmbienteSifen;
  /** Teléfono emisor 8–15 dígitos (solo números). */
  emisorTelefono: string;
  /** Email emisor válido según patrón SIFEN. */
  emisorEmail: string;
  /** Dirección emisor (mín. 1 carácter significativo). */
  emisorDireccion: string;
  /** Número de casa emisor (entero). */
  emisorNumCasa: number;
  /** Código departamento emisor (tabla SET). Por defecto 1 Capital. */
  emisorDepartamento?: string;
  emisorDepartamentoDescripcion?: string;
  /** Distrito y ciudad emisor (opcionales; si se omiten no se envían nodos). */
  emisorDistrito?: string;
  emisorDistritoDescripcion?: string;
  emisorCiudad?: string;
  emisorCiudadDescripcion?: string;
  /** Actividad económica principal (código + descripción). */
  actividadEconomicaCodigo?: string;
  actividadEconomicaDescripcion?: string;
  /** Momento de emisión / firma (por defecto ahora). */
  fechaHoraEmision?: Date;
}

function vigenciaIso(dateYmd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!m) throw new Error(`Fecha timbrado inválida (use YYYY-MM-DD): ${dateYmd}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Construye el XML rDE oficial (factura electrónica) listo para firmar el nodo `DE`.
 */
export function buildOfficialRdeFacturaElectronicaXml(
  base: SifenFacturaPayloadBase,
  opts: BuildRdeXmlOptions
): string {
  const { emisor, documento, receptor, items } = base;
  if (documento.moneda !== "GS") {
    throw new Error(
      "RDE Factura Electrónica: por ahora solo moneda GS (PYG). USD requiere tipo de cambio en gOpeCom."
    );
  }

  const ambiente: AmbienteSifen = opts.ambiente ?? "produccion";
  const esAmbienteTest = ambiente === "test";

  let cscParaCodSeg: string;
  if (esAmbienteTest) {
    /** Si el timbrado de prueba tiene CSC en BD, SET valida CDC/dCodSeg contra ese valor; el genérico solo si no hay CSC. */
    const cscCfg = emisor.csc == null ? "" : String(emisor.csc).trim();
    cscParaCodSeg = cscCfg !== "" ? cscCfg : SIFEN_TEST_CSC_GENERICO;
  } else {
    const csc = emisor.csc;
    if (csc == null || String(csc).trim() === "") {
      throw new Error("Falta CSC en configuración SIFEN (empresa_sifen_config.csc) para generar el DE.");
    }
    cscParaCodSeg = String(csc).trim();
  }

  const { cuerpo: rucEmCuerpo, dDV: dDVEmi } = splitRucParaXml(emisor.ruc);
  const dRucEmCdc = padDigits(rucEmCuerpo, 8);
  const dNumTim = normalizarNumeroTimbrado(emisor.timbrado_numero);
  const dEst = normalizarCodigoTres(emisor.establecimiento);
  const dPunExp = normalizarCodigoTres(emisor.punto_expedicion);
  const dNumDoc = normalizarNumeroDocumentoSifen(documento.numero_factura);
  const fechaCdc = fechaEmisionCdc(documento.fecha);
  /** Debe coincidir con `gEmis.iTipCont` y entrar en el CDC antes de la fecha (SET / TIPS). */
  const iTipContEmi = iTipContCodigo(emisor.razon_social);

  /** Sin timestamp: mismo documento electrónico → mismo dCodSeg/CDC al regenerar XML (exigencia típica SET / trazabilidad). */
  const semillaSeg = base.sifen.factura_electronica_id;
  const dCodSeg = dCodSegNueveDigitos(cscParaCodSeg, semillaSeg);

  const { cdc, dDVId } = generarCdcFacturaElectronica({
    iTiDE: "1",
    dRucEm: dRucEmCdc,
    dDVEmi,
    dEst,
    dPunExp,
    numeroFactura: documento.numero_factura,
    fechaEmision: fechaCdc,
    iTipContEmisor: iTipContEmi,
    iTipEmi: "1",
    dCodSeg,
  });

  const ahora = opts.fechaHoraEmision ?? new Date();
  const dFeEmiDE = dFeEmiDeYFecFirma(documento.fecha, ahora);
  const dFecFirma = dFeEmiDE;

  const dFeIniT = vigenciaIso(opts.timbradoFechaInicio);

  const telEmi = opts.emisorTelefono.replace(/\D/g, "");
  if (telEmi.length < 8 || telEmi.length > 15) {
    throw new Error("emisorTelefono debe tener entre 8 y 15 dígitos para gEmis.dTelEmi.");
  }

  const dirEmi = opts.emisorDireccion.trim();
  if (dirEmi.length < 1) throw new Error("emisorDireccion es obligatoria.");

  const dep = (opts.emisorDepartamento ?? "1").trim();
  const depDes = (opts.emisorDepartamentoDescripcion ?? "CAPITAL").trim();
  const cAct = (opts.actividadEconomicaCodigo ?? "47111").trim();
  const dActDes = (opts.actividadEconomicaDescripcion ?? "Comercio al por menor").trim();

  const dNomEmi = esAmbienteTest ? SIFEN_TEST_LITERAL_DOCUMENTO : emisor.razon_social.trim();

  const gEmisParts: string[] = [
    "<gEmis>",
    /** Mismo relleno 8 dígitos que en el CDC; si no, SET TEST rechaza 1000. */
    textEl("dRucEm", dRucEmCdc),
    textEl("dDVEmi", dDVEmi),
    textEl("iTipCont", iTipContEmi),
    textEl("dNomEmi", dNomEmi),
    textEl("dDirEmi", dirEmi),
    textEl("dNumCas", opts.emisorNumCasa),
    textEl("cDepEmi", dep),
    textEl("dDesDepEmi", depDes),
  ];

  if (opts.emisorDistrito?.trim()) {
    gEmisParts.push(textEl("cDisEmi", opts.emisorDistrito.replace(/\D/g, "").slice(0, 4)));
    gEmisParts.push(textEl("dDesDisEmi", (opts.emisorDistritoDescripcion ?? "").trim() || "ASUNCION"));
  }
  if (opts.emisorCiudad?.trim()) {
    gEmisParts.push(textEl("cCiuEmi", opts.emisorCiudad.replace(/\D/g, "").slice(0, 5)));
    gEmisParts.push(textEl("dDesCiuEmi", (opts.emisorCiudadDescripcion ?? "").trim() || "ASUNCION"));
  } else {
    gEmisParts.push(textEl("cCiuEmi", "1"));
    gEmisParts.push(textEl("dDesCiuEmi", "ASUNCION (DISTRITO)"));
  }

  gEmisParts.push(textEl("dTelEmi", telEmi));
  gEmisParts.push(textEl("dEmailE", opts.emisorEmail.trim()));
  gEmisParts.push("<gActEco>");
  gEmisParts.push(textEl("cActEco", cAct));
  gEmisParts.push(textEl("dDesActEco", dActDes));
  gEmisParts.push("</gActEco>");
  gEmisParts.push("</gEmis>");

  const recParts: string[] = ["<gDatRec>"];
  if (receptor.ruc?.trim()) {
    const { cuerpo: dRucRec, dDV: dDVRec } = splitRucParaXml(receptor.ruc.trim());
    const iTiContRec = iTipContCodigo(receptor.nombre);
    recParts.push(textEl("iNatRec", "1"));
    recParts.push(textEl("iTiOpe", "1"));
    recParts.push(textEl("cPaisRec", "PRY"));
    recParts.push(textEl("dDesPaisRe", "Paraguay"));
    recParts.push(textEl("iTiContRec", iTiContRec));
    recParts.push(textEl("dRucRec", padDigits(dRucRec, 8)));
    recParts.push(textEl("dDVRec", dDVRec));
    recParts.push(textEl("dNomRec", receptor.nombre.trim()));
    if (receptor.direccion?.trim()) recParts.push(textEl("dDirRec", receptor.direccion.trim()));
    if (receptor.telefono?.trim()) {
      const tr = receptor.telefono.replace(/\D/g, "");
      if (tr.length >= 8) recParts.push(textEl("dTelRec", tr.slice(0, 15)));
    }
    if (receptor.email?.trim()) recParts.push(textEl("dEmailRec", receptor.email.trim()));
  } else {
    const doc = (receptor.documento ?? "").replace(/\s/g, "").trim();
    if (!doc) throw new Error("Receptor sin RUC: se requiere documento (CI) en cliente.");
    recParts.push(textEl("iNatRec", "2"));
    recParts.push(textEl("iTiOpe", "1"));
    recParts.push(textEl("cPaisRec", "PRY"));
    recParts.push(textEl("dDesPaisRe", "Paraguay"));
    recParts.push(textEl("iTipIDRec", "1"));
    recParts.push(textEl("dDTipIDRec", XSD_DES_DOC_CI_PY));
    recParts.push(textEl("dNumIDRec", doc.slice(0, 20)));
    recParts.push(textEl("dNomRec", receptor.nombre.trim()));
    if (receptor.direccion?.trim()) recParts.push(textEl("dDirRec", receptor.direccion.trim()));
    if (receptor.telefono?.trim()) {
      const tr = receptor.telefono.replace(/\D/g, "");
      if (tr.length >= 8) recParts.push(textEl("dTelRec", tr.slice(0, 15)));
    }
    if (receptor.email?.trim()) recParts.push(textEl("dEmailRec", receptor.email.trim()));
  }
  recParts.push("</gDatRec>");

  const itemsXml: string[] = [];
  let sumSub10 = 0;
  let sumSub5 = 0;
  let sumSubExe = 0;
  let sumIva10 = 0;
  let sumIva5 = 0;
  let sumBase10 = 0;
  let sumBase5 = 0;

  items.forEach((it, idx) => {
    const tasa = inferirTasaIva(it.subtotal, it.iva);
    const dTotOpeItem = Math.round(it.total);
    const dLiq = Math.round(it.iva);
    const baseGrav = tasa === 0 ? 0 : Math.max(0, Math.round(it.subtotal));

    if (tasa === 10) {
      sumSub10 += dTotOpeItem;
      sumIva10 += dLiq;
      sumBase10 += baseGrav;
    } else if (tasa === 5) {
      sumSub5 += dTotOpeItem;
      sumIva5 += dLiq;
      sumBase5 += baseGrav;
    } else {
      sumSubExe += dTotOpeItem;
    }

    const iAfec = tasa === 0 ? "3" : "1";
    const cUniMed = "77";
    const dDesUniMed = XSD_DES_UNI_MED;
    const dCant = Number(it.cantidad);
    const cantStr = Number.isFinite(dCant) ? String(dCant) : "1";

    const subR = Math.round(it.subtotal);
    const ivaR = Math.round(it.iva);
    const dTotBruOpeItem = Math.max(dTotOpeItem, subR + ivaR, subR);

    itemsXml.push("<gCamItem>");
    itemsXml.push(textEl("dCodInt", `L${idx + 1}`.slice(0, 20)));
    const dDesProSer =
      esAmbienteTest && idx === 0
        ? SIFEN_TEST_LITERAL_DOCUMENTO
        : it.descripcion.slice(0, 120);
    itemsXml.push(textEl("dDesProSer", dDesProSer));
    itemsXml.push(textEl("cUniMed", cUniMed));
    itemsXml.push(textEl("dDesUniMed", dDesUniMed));
    itemsXml.push(textEl("dCantProSer", cantStr));
    itemsXml.push("<gValorItem>");
    itemsXml.push(textEl("dPUniProSer", montoGs(it.precio_unitario)));
    itemsXml.push(textEl("dTotBruOpeItem", dTotBruOpeItem));
    itemsXml.push("<gValorRestaItem>");
    itemsXml.push(textEl("dDescItem", "0"));
    itemsXml.push(textEl("dTotOpeItem", dTotOpeItem));
    itemsXml.push(textEl("dTotOpeGs", dTotOpeItem));
    itemsXml.push("</gValorRestaItem>");
    itemsXml.push("</gValorItem>");
    itemsXml.push("<gCamIVA>");
    itemsXml.push(textEl("iAfecIVA", iAfec));
    itemsXml.push(textEl("dDesAfecIVA", descripcionAfectacion(tasa)));
    itemsXml.push(textEl("dPropIVA", tasa === 0 ? 0 : 100));
    itemsXml.push(textEl("dTasaIVA", tasa));
    itemsXml.push(textEl("dBasGravIVA", baseGrav));
    itemsXml.push(textEl("dLiqIVAItem", dLiq));
    itemsXml.push(textEl("dBasExe", tasa === 0 ? dTotOpeItem : 0));
    itemsXml.push("</gCamIVA>");
    itemsXml.push("</gCamItem>");
  });

  const dTotOpe = sumSub10 + sumSub5 + sumSubExe;
  const dTotIVA = sumIva10 + sumIva5;
  const dTotGralOpe = dTotOpe;
  const dTBasGraIVA = sumBase5 + sumBase10;

  /** Secuencia estricta `tgTotSub` en DE_v150.xsd */
  const totParts: string[] = ["<gTotSub>"];
  if (sumSubExe > 0) totParts.push(textEl("dSubExe", sumSubExe));
  if (sumSub5 > 0) totParts.push(textEl("dSub5", sumSub5));
  if (sumSub10 > 0) totParts.push(textEl("dSub10", sumSub10));
  totParts.push(
    textEl("dTotOpe", dTotOpe),
    textEl("dTotDesc", "0"),
    textEl("dTotDescGlotem", "0"),
    textEl("dTotAntItem", "0"),
    textEl("dTotAnt", "0"),
    textEl("dPorcDescTotal", "0"),
    textEl("dDescTotal", "0"),
    textEl("dAnticipo", "0"),
    textEl("dRedon", montoRedondeo(0)),
    textEl("dTotGralOpe", dTotGralOpe)
  );
  if (sumIva5 > 0) totParts.push(textEl("dIVA5", sumIva5));
  if (sumIva10 > 0) totParts.push(textEl("dIVA10", sumIva10));
  if (dTotIVA > 0) totParts.push(textEl("dTotIVA", dTotIVA));
  if (sumBase5 > 0) totParts.push(textEl("dBaseGrav5", sumBase5));
  if (sumBase10 > 0) totParts.push(textEl("dBaseGrav10", sumBase10));
  if (dTBasGraIVA > 0) totParts.push(textEl("dTBasGraIVA", dTBasGraIVA));
  totParts.push(textEl("dTotalGs", dTotGralOpe));
  totParts.push("</gTotSub>");

  const esCredito = documento.tipo === "credito" || documento.tipo === "suscripcion";
  let gCamCondXml: string;
  if (esCredito) {
    gCamCondXml = [
      "<gCamCond>",
      textEl("iCondOpe", "2"),
      textEl("dDCondOpe", "Crédito"),
      "<gPagCred>",
      textEl("iCondCred", "1"),
      textEl("dDCondCred", XSD_D_COND_CRED_PLAZO),
      textEl("dPlazoCre", "30"),
      "</gPagCred>",
      "</gCamCond>",
    ].join("");
  } else {
    gCamCondXml = [
      "<gCamCond>",
      textEl("iCondOpe", "1"),
      textEl("dDCondOpe", "Contado"),
      "<gPaConEIni>",
      textEl("iTiPago", "1"),
      textEl("dDesTiPag", "Efectivo"),
      textEl("dMonTiPag", dTotGralOpe),
      textEl("cMoneTiPag", "PYG"),
      textEl("dDMoneTiPag", XSD_DES_MONE_PYG),
      "</gPaConEIni>",
      "</gCamCond>",
    ].join("");
  }

  const deInner = [
    textEl("dDVId", dDVId),
    textEl("dFecFirma", dFecFirma),
    textEl("dSisFact", "1"),
    "<gOpeDE>",
    textEl("iTipEmi", "1"),
    textEl("dDesTipEmi", "Normal"),
    textEl("dCodSeg", dCodSeg),
    "</gOpeDE>",
    "<gTimb>",
    textEl("iTiDE", "1"),
    textEl("dDesTiDE", XSD_DES_TI_DE_FACTURA),
    textEl("dNumTim", dNumTim),
    textEl("dEst", dEst),
    textEl("dPunExp", dPunExp),
    textEl("dNumDoc", dNumDoc),
    textEl("dFeIniT", dFeIniT),
    "</gTimb>",
    "<gDatGralOpe>",
    textEl("dFeEmiDE", dFeEmiDE),
    "<gOpeCom>",
    textEl("iTipTra", "1"),
    textEl("dDesTipTra", XSD_DES_TIP_TRA_VENTA_MERC),
    textEl("iTImp", "1"),
    textEl("dDesTImp", XSD_DES_T_IMP_IVA),
    textEl("cMoneOpe", "PYG"),
    textEl("dDesMoneOpe", XSD_DES_MONE_PYG),
    "</gOpeCom>",
    ...gEmisParts,
    ...recParts,
    "</gDatGralOpe>",
    "<gDtipDE>",
    "<gCamFE>",
    textEl("iIndPres", "1"),
    textEl("dDesIndPres", XSD_DES_IND_PRES_PRESENCIAL),
    "</gCamFE>",
    gCamCondXml,
    ...itemsXml,
    "</gDtipDE>",
    ...totParts,
  ].join("");

  const de = `<DE Id="${escapeXml(cdc)}">${deInner}</DE>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rDE xmlns="${NS}" xmlns:xsi="${XMLNS_XSI}" xsi:schemaLocation="${escapeXml(RDE_XSI_SCHEMA_LOCATION)}">` +
    textEl("dVerFor", "150") +
    de +
    `</rDE>\n`;

  return xml;
}
