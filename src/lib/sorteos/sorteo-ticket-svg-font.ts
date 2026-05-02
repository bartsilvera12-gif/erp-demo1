import "server-only";

import fs from "node:fs";
import path from "node:path";

/**
 * Sharp rasteriza SVG→PNG con librsvg sin fuentes OS en Linux/Vercel: `system-ui`, Arial, etc.
 * fallan y el texto sale como □. Incrustamos Inter (latin) como data:woff2 en el SVG.
 */
let cachedCss: string | null = null;

export function getSorteoTicketSvgEmbeddedFontCss(): string {
  if (cachedCss) return cachedCss;
  try {
    const dir = path.join(process.cwd(), "node_modules/@fontsource/inter/files");
    const faces: [string, string][] = [
      ["400", "inter-latin-400-normal.woff2"],
      ["600", "inter-latin-600-normal.woff2"],
      ["700", "inter-latin-700-normal.woff2"],
      ["800", "inter-latin-800-normal.woff2"],
    ];
    const chunks: string[] = [];
    for (const [weight, file] of faces) {
      const fp = path.join(dir, file);
      const buf = fs.readFileSync(fp);
      chunks.push(
        `@font-face{font-family:SorteoTicketInter;font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${buf.toString("base64")}) format("woff2");}`
      );
    }
    cachedCss = chunks.join("\n");
    return cachedCss;
  } catch (e) {
    console.warn("[sorteo-ticket] embedded_font_load_failed", {
      message: e instanceof Error ? e.message : String(e),
    });
    return "";
  }
}

/** Usar en elementos `<text>` del ticket (nombre coincide con @font-face). */
export const SORTEO_TICKET_FONT_FAMILY = "SorteoTicketInter";
