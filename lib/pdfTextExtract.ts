export type TextItem = {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
};

export type EmptyZone = {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  context: string;
  /** Texto impreso que hay encima/izquierda del campo (para que la IA entienda mejor) */
  labelContext?: string;
};

export type PageStructure = {
  pageNum: number;
  width: number;
  height: number;
  textItems: TextItem[];
  emptyZones: EmptyZone[];
  structuredText: string;
  hasEnoughText: boolean;
};

type PdfTextContentItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

type PdfTextContent = {
  items: PdfTextContentItem[];
};

type PdfPageLike = {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<PdfTextContent>;
};

type PdfDocumentLike = {
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export async function extractPageStructure(pdfDoc: PdfDocumentLike, pageIndex: number): Promise<PageStructure> {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const textItems: TextItem[] = content.items
    .filter((item) => item.str?.trim())
    .map((item) => {
      const tx = item.transform || [1, 0, 0, 9, 0, 0];
      const fontSize = Math.max(6, Math.round(Math.abs(tx[3] || tx[0] || item.height || 9)));
      return {
        str: normalizeLine(item.str || ""),
        x: round2(tx[4] || 0),
        y: round2(viewport.height - (tx[5] || 0)),
        w: round2(item.width || 0),
        h: round2(Math.abs(tx[3] || tx[0] || item.height || 9)),
        fontSize
      };
    })
    .sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > 5) return yDiff;
      return a.x - b.x;
    });

  const emptyZones = detectEmptyZones(textItems, viewport.width, viewport.height);
  const structuredText = buildStructuredText(textItems, emptyZones, viewport.width, viewport.height);

  return {
    pageNum: pageIndex,
    width: viewport.width,
    height: viewport.height,
    textItems,
    emptyZones,
    structuredText,
    hasEnoughText: textItems.length >= 5
  };
}

// ── Helpers de búsqueda en línea ──────────────────────────────────

function findPreviousInLine(items: TextItem[], target: TextItem): TextItem | undefined {
  return items
    .filter((item) => Math.abs(item.y - target.y) < 6 && item.x < target.x)
    .sort((a, b) => b.x - a.x)[0];
}

function findNextInLine(items: TextItem[], target: TextItem, startX: number): TextItem | undefined {
  return items
    .filter((item) => Math.abs(item.y - target.y) < 6 && item.x > startX + 5 && item !== target)
    .sort((a, b) => a.x - b.x)[0];
}

/** Encuentra el ítem de texto más cercano que está arriba de un punto dado */
function findLabelAbove(items: TextItem[], x: number, y: number, rangeY = 30): TextItem | undefined {
  return items
    .filter((item) => item.y < y && item.y > y - rangeY && Math.abs(item.x - x) < 80)
    .sort((a, b) => b.y - a.y)[0];
}

function addZone(zones: EmptyZone[], zone: EmptyZone): void {
  const duplicate = zones.some(
    (current) =>
      Math.abs(current.x - zone.x) < 8 &&
      Math.abs(current.y - zone.y) < 8 &&
      current.context === zone.context
  );
  if (!duplicate && zone.w >= 12 && zone.h >= 8) {
    zones.push(zone);
  }
}

// ── Detectores de patrones ────────────────────────────────────────

/** "Yo, ___" → representante legal */
function detectYoPattern(text: string): boolean {
  return /^yo,?\s*$/i.test(text.trim()) || /^yo\s+\w/i.test(text.trim());
}

/** "identificado/a con C.C./NIT No. ___" */
function detectIdWithPattern(text: string): "documento_identidad" | "nit" | null {
  if (/identificad[oa]\s+(con\s+)?(c\.?c\.?|cedula)/i.test(text)) return "documento_identidad";
  if (/identificad[oa]\s+(con\s+)?nit/i.test(text)) return "nit";
  return null;
}

/** "en representación de: ___" → razón social */
function detectEnRepresentacionDe(text: string): boolean {
  return /en\s+representaci[oó]n\s+de/i.test(text);
}

/** Detecta checkboxes tipo [ ] o ( ) en el texto */
function detectCheckboxMarkers(text: string): boolean {
  return /\[\s*\]|\(\s*\)|\□/.test(text);
}

// ── Detección principal de zonas vacías ──────────────────────────

function detectEmptyZones(items: TextItem[], pageWidth: number, pageHeight: number): EmptyZone[] {
  const zones: EmptyZone[] = [];

  for (const item of items) {
    const text = item.str.trim();
    const lower = text.toLowerCase();

    // ── 1. Etiqueta seguida de ":" ─────────────────────────────
    if (text.endsWith(":") || text.endsWith(": ")) {
      const labelEnd = item.x + item.w;
      const nextInLine = findNextInLine(items, item, labelEnd);
      const zoneEnd = nextInLine ? nextInLine.x - 2 : pageWidth - 30;

      if (zoneEnd - labelEnd > 20) {
        const cleanLabel = text.replace(/:?\s*$/, "").trim();
        addZone(zones, {
          label: cleanLabel,
          x: Math.round(labelEnd + 4),
          y: Math.round(item.y),
          w: Math.round(zoneEnd - labelEnd - 4),
          h: Math.round(item.h + 4),
          fontSize: item.fontSize,
          context: `after_label:${cleanLabel}`,
          labelContext: cleanLabel
        });
      }
    }

    // ── 2. Líneas de subrayado ___ --- ... ────────────────────
    if (/_{3,}|-{6,}|\.{6,}/.test(text)) {
      const prevItem = findPreviousInLine(items, item);
      const labelAbove = !prevItem ? findLabelAbove(items, item.x, item.y) : undefined;
      const label = prevItem
        ? prevItem.str.replace(/:?\s*$/, "").trim()
        : (labelAbove?.str.replace(/:?\s*$/, "").trim() || "Campo");

      addZone(zones, {
        label,
        x: Math.round(item.x),
        y: Math.round(item.y),
        w: Math.round(Math.max(item.w, 80)),
        h: Math.round(item.h + 4),
        fontSize: item.fontSize,
        context: `underline:${label}`,
        labelContext: label
      });
    }

    // ── 3. Patrón "Yo, ___" → representante legal ─────────────
    if (detectYoPattern(text)) {
      const afterX = item.x + item.w;
      const nextInLine = findNextInLine(items, item, afterX);
      const zoneEnd = nextInLine ? nextInLine.x - 2 : pageWidth - 30;
      if (zoneEnd - afterX > 30) {
        addZone(zones, {
          label: "Representante Legal",
          x: Math.round(afterX + 4),
          y: Math.round(item.y),
          w: Math.round(zoneEnd - afterX - 4),
          h: Math.round(item.h + 4),
          fontSize: item.fontSize,
          context: "yo_patron:representante_legal",
          labelContext: "Yo,"
        });
      }
    }

    // ── 4. "identificado/a con C.C./NIT No. ___" ─────────────
    const idMatch = detectIdWithPattern(text);
    if (idMatch) {
      // Buscar el campo vacío después del "No." o al final
      const afterNoMatch = text.match(/no\.?\s*$/i);
      const afterX = afterNoMatch
        ? item.x + item.w
        : item.x + item.w + 4;
      const nextInLine = findNextInLine(items, item, afterX);
      const zoneEnd = nextInLine ? nextInLine.x - 2 : pageWidth - 30;
      if (zoneEnd - afterX > 20) {
        addZone(zones, {
          label: idMatch === "documento_identidad" ? "C.C." : "NIT",
          x: Math.round(afterX + 2),
          y: Math.round(item.y),
          w: Math.round(Math.min(zoneEnd - afterX - 2, 150)),
          h: Math.round(item.h + 4),
          fontSize: item.fontSize,
          context: `id_patron:${idMatch}`,
          labelContext: text
        });
      }
    }

    // ── 5. "en representación de:" → razón social ─────────────
    if (detectEnRepresentacionDe(text)) {
      const afterX = item.x + item.w;
      const nextInLine = findNextInLine(items, item, afterX);
      const zoneEnd = nextInLine ? nextInLine.x - 2 : pageWidth - 30;
      if (zoneEnd - afterX > 30) {
        addZone(zones, {
          label: "Razon Social",
          x: Math.round(afterX + 4),
          y: Math.round(item.y),
          w: Math.round(zoneEnd - afterX - 4),
          h: Math.round(item.h + 4),
          fontSize: item.fontSize,
          context: "representacion_de:razon_social",
          labelContext: "en representación de"
        });
      }
    }

    // ── 6. Checkboxes Si / No ─────────────────────────────────
    if ((lower === "si" || lower === "sí" || lower === "no") && item.w < 30) {
      addZone(zones, {
        label: `Checkbox ${text}`,
        x: Math.round(item.x + item.w + 2),
        y: Math.round(item.y),
        w: 18,
        h: Math.round(item.h),
        fontSize: item.fontSize,
        context: `checkbox:${text}`,
        labelContext: text
      });
    }

    // ── 7. Markers de checkbox [ ] ( ) □ ──────────────────────
    if (detectCheckboxMarkers(text)) {
      const prevItem = findPreviousInLine(items, item);
      addZone(zones, {
        label: prevItem ? `Checkbox ${prevItem.str.replace(/:?\s*$/, "").trim()}` : "Checkbox",
        x: Math.round(item.x + 2),
        y: Math.round(item.y + 1),
        w: Math.round(Math.min(item.w - 4, 16)),
        h: Math.round(item.h - 2),
        fontSize: item.fontSize,
        context: `checkbox_marker:${prevItem?.str || "unknown"}`,
        labelContext: prevItem?.str || ""
      });
    }
  }

  // ── 8. Zona de firma (60%+ de la página) ──────────────────────
  const firmaThreshold = pageHeight * 0.60;
  const firmaItems = items.filter(
    (item) => item.y > firmaThreshold && /firma|sign|suscri/i.test(item.str)
  );
  for (const firmaItem of firmaItems) {
    addZone(zones, {
      label: "Firma",
      x: Math.round(firmaItem.x),
      y: Math.round(Math.max(0, firmaItem.y - 42)),
      w: 120,
      h: 40,
      fontSize: 9,
      context: `firma_zone:${Math.round(firmaItem.y)}`,
      labelContext: firmaItem.str
    });
  }

  // ── 9. Zona de huella (60%+ de la página) ─────────────────────
  const huellaItems = items.filter(
    (item) => item.y > pageHeight * 0.60 && /huella|dactilar/i.test(item.str)
  );
  for (const huellaItem of huellaItems) {
    addZone(zones, {
      label: "Huella",
      x: Math.round(huellaItem.x),
      y: Math.round(Math.max(0, huellaItem.y - 82)),
      w: 60,
      h: 80,
      fontSize: 9,
      context: `huella_zone:${Math.round(huellaItem.y)}`,
      labelContext: huellaItem.str
    });
  }

  return zones;
}

// ── Agrupación de líneas ──────────────────────────────────────────

function groupLines(items: TextItem[]): TextItem[][] {
  const lineGroups: TextItem[][] = [];
  let currentLine: TextItem[] = [];
  let lastY = -999;

  for (const item of items) {
    if (Math.abs(item.y - lastY) > 5) {
      if (currentLine.length) lineGroups.push(currentLine);
      currentLine = [item];
      lastY = item.y;
    } else {
      currentLine.push(item);
    }
  }

  if (currentLine.length) lineGroups.push(currentLine);
  return lineGroups;
}

// ── Texto estructurado para la IA ────────────────────────────────

function buildStructuredText(items: TextItem[], zones: EmptyZone[], pageWidth: number, pageHeight: number): string {
  const lines: string[] = [];
  const lineGroups = groupLines(items);

  lines.push(`PAGINA: ${Math.round(pageWidth)}x${Math.round(pageHeight)} puntos`);
  lines.push("");
  lines.push("=== TEXTO ENCONTRADO (posiciones exactas del PDF) ===");

  for (const group of lineGroups) {
    const y = group[0].y;
    const lineText = group
      .map((item) => `"${item.str}" (x:${item.x}, w:${item.w}, fs:${item.fontSize})`)
      .join(" | ");
    lines.push(`  Y=${Math.round(y)}: ${lineText}`);
  }

  lines.push("");
  lines.push("=== ZONAS VACIAS DETECTADAS (coordenadas exactas para rellenar) ===");
  lines.push("IMPORTANTE: Usa estas coordenadas x/y directamente. No las inventes.");

  for (const zone of zones) {
    const ctx = zone.labelContext ? ` [etiqueta: "${zone.labelContext}"]` : "";
    lines.push(
      `  ZONA "${zone.label}"${ctx}: x=${zone.x} y=${zone.y} w=${zone.w} h=${zone.h} fs=${zone.fontSize} ctx=${zone.context}`
    );
  }

  if (zones.length === 0) {
    lines.push("  (sin zonas detectadas - usar Vision para este PDF)");
  }

  return lines.join("\n");
}
