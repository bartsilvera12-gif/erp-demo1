/**
 * Construye payload `template` para Meta Cloud API / YCloud a partir del snapshot de plantilla y variables por slot ({{1}}, {{2}}, …).
 */
import "server-only";
import {
  isHttpsUrl,
  logTemplatePayloadHeaderImage,
  templateSnapshotHasHeaderImage,
} from "@/lib/campaigns/campaign-header-image";

export function extractBodyVariableSlotsOrdered(componentsJson: unknown[]): string[] {
  const comps = Array.isArray(componentsJson)
    ? (componentsJson as { type?: string; text?: string }[])
    : [];
  const body = comps.find((c) => String(c.type ?? "").toUpperCase() === "BODY");
  const text = body?.text ?? "";
  const re = /\{\{(\d+)\}\}/g;
  const ordered: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slot = m[1];
    if (!seen.has(slot)) {
      seen.add(slot);
      ordered.push(slot);
    }
  }
  return ordered.sort((a, b) => Number(a) - Number(b));
}

/** `mappedBySlot`: claves "1","2" → texto final para cada {{n}} */
export function buildMetaCloudTemplatePayload(params: {
  templateName: string;
  languageCode: string;
  componentsSnapshot: unknown[];
  mappedBySlot: Record<string, string>;
  /** URL https pública para HEADER IMAGE (misma para toda la campaña, fase 1). */
  headerImageUrl?: string | null;
}): Record<string, unknown> {
  const components: Array<Record<string, unknown>> = [];
  const needsHeader = templateSnapshotHasHeaderImage(params.componentsSnapshot);
  const headerUrl = String(params.headerImageUrl ?? "").trim();

  if (needsHeader && headerUrl && isHttpsUrl(headerUrl)) {
    try {
      logTemplatePayloadHeaderImage(new URL(headerUrl).hostname);
    } catch {
      logTemplatePayloadHeaderImage("(parse)");
    }
    components.push({
      type: "header",
      parameters: [
        {
          type: "image",
          image: {
            link: headerUrl.slice(0, 4000),
          },
        },
      ],
    });
  }

  const slots = extractBodyVariableSlotsOrdered(params.componentsSnapshot);
  const bodyParameters = slots.map((slot) => ({
    type: "text",
    text: String(params.mappedBySlot[slot] ?? "").slice(0, 4096),
  }));

  if (bodyParameters.length > 0) {
    components.push({ type: "body", parameters: bodyParameters });
  }

  const template: Record<string, unknown> = {
    name: params.templateName,
    language: { code: params.languageCode },
  };

  if (components.length > 0) {
    template.components = components;
  }

  return template;
}

/**
 * Texto legible para inbox (plantilla + cuerpo con variables resueltas).
 */
export function buildCampaignTemplatePreviewText(params: {
  templateName: string;
  languageCode: string;
  componentsSnapshot: unknown[];
  mappedBySlot: Record<string, string>;
}): string {
  const comps = Array.isArray(params.componentsSnapshot)
    ? (params.componentsSnapshot as { type?: string; text?: string }[])
    : [];
  const body = comps.find((c) => String(c.type ?? "").toUpperCase() === "BODY");
  let bodyText = String(body?.text ?? "").trim();
  if (bodyText) {
    bodyText = bodyText.replace(/\{\{(\d+)\}\}/g, (_, slot) => {
      const v = params.mappedBySlot[slot];
      return v !== undefined && v !== null ? String(v).trim() : `{{${slot}}}`;
    });
  }
  const title = `Plantilla: ${params.templateName} · ${params.languageCode}`;
  if (bodyText) return `${title}\n\n${bodyText}`;
  return `${title}\n\n(Sin cuerpo de texto en snapshot)`;
}
