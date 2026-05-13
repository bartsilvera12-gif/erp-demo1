/**
 * Dry-run local (sin SET, sin firma): valida ramas gDatRec del XML SIFEN v150.
 * Ejecutar: npx tsx scripts/sifen-dry-run-receptor-xml.ts
 */
import type { SifenFacturaPayloadBase } from "../src/lib/sifen/types";
import { buildOfficialRdeFacturaElectronicaXml } from "../src/lib/sifen/rde-xml";

const emisorBase = {
  ruc: "4192083-5",
  razon_social: "Emisor Prueba SRL",
  direccion_fiscal: "Av. Dry Run 1000 (no es razón social)",
  timbrado_numero: "12345678",
  timbrado_fecha_inicio_vigencia: "2026-01-01",
  actividad_economica_codigo: "47111",
  actividad_economica_descripcion: "Comercio minorista",
  establecimiento: "001",
  punto_expedicion: "001",
  csc: null,
} as const;

const documentoBase = {
  factura_id: "00000000-0000-4000-8000-0000000000aa",
  numero_factura: "FAC-000002",
  fecha: "2026-05-13",
  tipo: "venta",
  moneda: "GS",
  monto: 1100,
  saldo: 0,
} as const;

const items = [
  {
    descripcion: "Servicio de prueba",
    cantidad: 1,
    precio_unitario: 1000,
    subtotal: 1000,
    iva: 100,
    total: 1100,
  },
];

const sifenMeta = {
  factura_electronica_id: "00000000-0000-4000-8000-0000000000bb",
  estado_sifen: "borrador" as const,
};

const xmlOpts = {
  timbradoFechaInicio: "2026-01-01",
  ambiente: "test" as const,
  emisorTelefono: "0210000000",
  emisorEmail: "dry-run@example.com.py",
  emisorDireccion: emisorBase.direccion_fiscal,
  emisorNumCasa: 1,
  actividadEconomicaCodigo: emisorBase.actividad_economica_codigo,
  actividadEconomicaDescripcion: emisorBase.actividad_economica_descripcion,
};

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function extractGDatRec(xml: string): string {
  const a = xml.indexOf("<gDatRec>");
  const b = xml.indexOf("</gDatRec>");
  assert(a >= 0 && b > a, "No se encontró gDatRec en el XML");
  return xml.slice(a, b + "</gDatRec>".length);
}

function runCase(name: string, receptor: SifenFacturaPayloadBase["receptor"], checks: { mustHave?: string[]; mustNot?: string[] }) {
  const base: SifenFacturaPayloadBase = {
    emisor: { ...emisorBase },
    documento: { ...documentoBase },
    receptor,
    items,
    sifen: { ...sifenMeta },
  };
  const xml = buildOfficialRdeFacturaElectronicaXml(base, xmlOpts);
  const bloque = extractGDatRec(xml);
  for (const s of checks.mustHave ?? []) {
    assert(bloque.includes(s), `${name}: debe contener ${s}`);
  }
  for (const s of checks.mustNot ?? []) {
    assert(!bloque.includes(s), `${name}: no debe contener ${s}`);
  }
  console.log(`OK: ${name}`);
}

runCase(
  "receptor paraguayo con RUC (dRucRec/dDVRec)",
  {
    cliente_id: "00000000-0000-4000-8000-000000000001",
    nombre: "Cliente Local SA",
    ruc: "4192083-5",
    documento: null,
    direccion: null,
    telefono: null,
    email: null,
    receptor_extranjero: false,
  },
  { mustHave: ["<dRucRec>", "<dDVRec>", "<cPaisRec>PRY</cPaisRec>"], mustNot: ["<dNumIDRec>"] }
);

runCase(
  "receptor paraguayo solo CI (sin dRucRec)",
  {
    cliente_id: "00000000-0000-4000-8000-000000000002",
    nombre: "Persona Natural",
    ruc: null,
    documento: "1234567",
    direccion: null,
    telefono: null,
    email: null,
    receptor_extranjero: false,
  },
  { mustHave: ["<dNumIDRec>1234567</dNumIDRec>", "<cPaisRec>PRY</cPaisRec>"], mustNot: ["<dRucRec>"] }
);

runCase(
  "receptor extranjero PER (sin dRucRec; identificación 11 dígitos)",
  {
    cliente_id: "00000000-0000-4000-8000-000000000003",
    nombre: "QUEIPOS SAC (ejemplo genérico)",
    ruc: "20603666098",
    documento: "20603666098",
    direccion: null,
    telefono: null,
    email: null,
    receptor_extranjero: true,
    codigo_pais_iso3: "PER",
    tipo_doc_receptor: 9,
    num_id_receptor: "20603666098",
  },
  {
    mustHave: ["<cPaisRec>PER</cPaisRec>", "<dNumIDRec>20603666098</dNumIDRec>", "<iTipIDRec>9</iTipIDRec>"],
    mustNot: ["<dRucRec>", "<dDVRec>"],
  }
);

console.log("\nDry-run receptor SIFEN: todas las comprobaciones pasaron (sin envío a SET).");
