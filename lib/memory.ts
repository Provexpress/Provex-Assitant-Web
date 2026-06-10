import { LEGACY_MEMORY_SEED } from "./memorySeed";
import type { LocalMemory, PdfField } from "./types";

const STORAGE_KEY = "provex-assitant-web-memory-v1";

function legacyToLocalMemory(): LocalMemory {
  const legacy = LEGACY_MEMORY_SEED as unknown as {
    patrones_globales?: Array<Record<string, unknown>>;
    formularios_conocidos?: Record<string, { paginas?: Record<string, { campos?: Array<Record<string, unknown>> }>; veces_procesado?: number }>;
    historial_correcciones?: Array<Record<string, unknown>>;
  };

  const formulariosConocidos: LocalMemory["formulariosConocidos"] = {};

  for (const [code, form] of Object.entries(legacy.formularios_conocidos || {})) {
    const fields: PdfField[] = [];
    for (const [pageText, page] of Object.entries(form.paginas || {})) {
      const pageNum = Number(pageText) || 0;
      for (const [index, field] of (page.campos || []).entries()) {
        const tipo = String(field.tipo || "texto") as PdfField["tipo"];
        fields.push({
          id: `seed_${code}_${pageNum}_${index}`,
          pageNum,
          nombre: String(field.nombre || "Campo"),
          valor: String(field.valor || ""),
          tipo: ["texto", "checkbox", "firma", "huella"].includes(tipo) ? tipo : "texto",
          x: Number(field.x || 0),
          y: Number(field.y || 0),
          w: Number(field.w || (tipo === "firma" ? 100 : tipo === "huella" ? 60 : 120)),
          h: Number(field.h || (tipo === "firma" ? 40 : tipo === "huella" ? 80 : 22)),
          fontSize: Number(field.fontsize || 9),
          confianza: Number(field.confianza || 0.75),
          source: "memoria"
        });
      }
    }
    formulariosConocidos[code] = {
      fields,
      vecesProcesado: Number(form.veces_procesado || 0)
    };
  }

  return {
    version: 1,
    patronesGlobales: (legacy.patrones_globales || []).map((pattern) => ({
      contexto: String(pattern.contexto || ""),
      offsetX: Number(pattern.offset_x || 0),
      offsetY: Number(pattern.offset_y || 0),
      vecesAplicado: Number(pattern.veces_aplicado || 0),
      vecesCorregido: Number(pattern.veces_corregido || 0)
    })),
    formulariosConocidos,
    historialCorrecciones: (legacy.historial_correcciones || []).map((item) => {
      const diff = (item.diferencia || {}) as Record<string, unknown>;
      return {
        fecha: String(item.fecha || ""),
        pdf: String(item.pdf || ""),
        campo: String(item.campo || ""),
        dx: Number(diff.x || 0),
        dy: Number(diff.y || 0)
      };
    })
  };
}

export function loadMemory(): LocalMemory {
  if (typeof window === "undefined") {
    return legacyToLocalMemory();
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seeded = legacyToLocalMemory();
    saveMemory(seeded);
    return seeded;
  }

  try {
    return JSON.parse(raw) as LocalMemory;
  } catch {
    const seeded = legacyToLocalMemory();
    saveMemory(seeded);
    return seeded;
  }
}

export function saveMemory(memory: LocalMemory): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
}

export function resetMemory(): LocalMemory {
  const seeded = legacyToLocalMemory();
  saveMemory(seeded);
  return seeded;
}

export function learnFromConfirmation(memory: LocalMemory, pdfName: string, fields: PdfField[]): LocalMemory {
  const next: LocalMemory = structuredClone(memory);
  const code = detectCode(pdfName);

  next.formulariosConocidos[code] = {
    fields: fields.map((field) => ({ ...field, source: "memoria", confianza: Math.min(0.98, field.confianza + 0.08) })),
    vecesProcesado: (next.formulariosConocidos[code]?.vecesProcesado || 0) + 1
  };

  for (const field of fields) {
    const dx = Number(field.x || 0) - Number(field.iaX ?? field.x);
    const dy = Number(field.y || 0) - Number(field.iaY ?? field.y);
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      next.historialCorrecciones.push({
        fecha: new Date().toISOString().slice(0, 10),
        pdf: pdfName,
        campo: field.nombre,
        dx,
        dy
      });
    }
  }

  saveMemory(next);
  return next;
}

export function detectCode(fileName: string): string {
  const match = fileName.toUpperCase().match(/[A-Z]{2,}-?[A-Z0-9]{2,}-?\d+[A-Z]?/);
  return match ? match[0].replace(/^INZ([A-Z]+)(\d)/, "INZ-$1-$2") : fileName.replace(/\.[^.]+$/, "");
}
