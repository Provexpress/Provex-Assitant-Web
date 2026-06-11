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

function findPreviousInLine(items: TextItem[], target: TextItem): TextItem | undefined {
  return items
    .filter((item) => Math.abs(item.y - target.y) < 5 && item.x < target.x)
    .sort((a, b) => b.x - a.x)[0];
}

function findNextInLine(items: TextItem[], target: TextItem, startX: number): TextItem | undefined {
  return items
    .filter((item) => Math.abs(item.y - target.y) < 5 && item.x > startX + 5 && item !== target)
    .sort((a, b) => a.x - b.x)[0];
}

function addZone(zones: EmptyZone[], zone: EmptyZone): void {
  const duplicate = zones.some(
    (current) =>
      Math.abs(current.x - zone.x) < 5 &&
      Math.abs(current.y - zone.y) < 5 &&
      current.context === zone.context
  );
  if (!duplicate && zone.w >= 12 && zone.h >= 8) {
    zones.push(zone);
  }
}

function detectEmptyZones(items: TextItem[], pageWidth: number, pageHeight: number): EmptyZone[] {
  const zones: EmptyZone[] = [];

  for (const item of items) {
    const text = item.str;
    const lower = text.toLowerCase().trim();

    if (text.endsWith(":") || text.endsWith(": ")) {
      const labelEnd = item.x + item.w;
      const nextInLine = findNextInLine(items, item, labelEnd);
      const zoneEnd = nextInLine ? nextInLine.x - 2 : pageWidth - 40;
      if (zoneEnd - labelEnd > 30) {
        addZone(zones, {
          label: text.replace(/:?\s*$/, ""),
          x: Math.round(labelEnd + 4),
          y: Math.round(item.y),
          w: Math.round(zoneEnd - labelEnd - 4),
          h: Math.round(item.h + 4),
          fontSize: item.fontSize,
          context: `after_label:${text}`
        });
      }
    }

    if (/_{3,}|-{6,}|\.{6,}/.test(text)) {
      const prevItem = findPreviousInLine(items, item);
      addZone(zones, {
        label: prevItem ? prevItem.str.replace(/:?\s*$/, "") : "Campo",
        x: Math.round(item.x),
        y: Math.round(item.y),
        w: Math.round(Math.max(item.w, 100)),
        h: Math.round(item.h + 4),
        fontSize: item.fontSize,
        context: `underline:${prevItem?.str || "unknown"}`
      });
    }

    if ((lower === "si" || lower === "sí" || lower === "no") && item.w < 30) {
      addZone(zones, {
        label: `Checkbox ${text}`,
        x: Math.round(item.x + item.w + 2),
        y: Math.round(item.y),
        w: 20,
        h: Math.round(item.h),
        fontSize: item.fontSize,
        context: `checkbox:${text}`
      });
    }
  }

  const bottomItems = items.filter((item) => item.y > pageHeight * 0.7);
  const firmaItem = bottomItems.find((item) => /firma|sign/i.test(item.str));
  if (firmaItem) {
    addZone(zones, {
      label: "Firma",
      x: Math.round(firmaItem.x),
      y: Math.round(Math.max(0, firmaItem.y - 40)),
      w: 120,
      h: 40,
      fontSize: 9,
      context: "firma_zone"
    });
  }

  const huellaItem = bottomItems.find((item) => /huella/i.test(item.str));
  if (huellaItem) {
    addZone(zones, {
      label: "Huella",
      x: Math.round(huellaItem.x),
      y: Math.round(Math.max(0, huellaItem.y - 80)),
      w: 60,
      h: 80,
      fontSize: 9,
      context: "huella_zone"
    });
  }

  return zones;
}

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

function buildStructuredText(items: TextItem[], zones: EmptyZone[], pageWidth: number, pageHeight: number): string {
  const lines: string[] = [];
  lines.push(`PAGINA: ${Math.round(pageWidth)}x${Math.round(pageHeight)} puntos`);
  lines.push("");
  lines.push("TEXTO ENCONTRADO:");

  for (const group of groupLines(items)) {
    const y = group[0].y;
    const lineText = group.map((item) => `"${item.str}" (x:${item.x}, w:${item.w})`).join(" | ");
    lines.push(`  Y=${Math.round(y)}: ${lineText}`);
  }

  lines.push("");
  lines.push("ZONAS VACIAS DETECTADAS (para rellenar):");
  for (const zone of zones) {
    lines.push(
      `  - "${zone.label}" -> posicion x:${zone.x} y:${zone.y} ancho:${zone.w} alto:${zone.h} font:${zone.fontSize} contexto:${zone.context}`
    );
  }

  return lines.join("\n");
}
