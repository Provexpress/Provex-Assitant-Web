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
          source: "memoria",
          iaX: Number(field.x || 0),
          iaY: Number(field.y || 0),
          suggestedX: Number(field.x || 0),
          suggestedY: Number(field.y || 0),
          manualSize: Boolean(field.manualSize)
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

function savedField(field: PdfField): PdfField {
  return {
    ...field,
    source: "memoria",
    confianza: Math.min(0.99, Math.max(0.92, field.confianza + 0.08)),
    iaX: field.x,
    iaY: field.y,
    suggestedX: field.x,
    suggestedY: field.y
  };
}

export function learnFromConfirmation(memory: LocalMemory, memoryKey: string, fields: PdfField[], aliases: string[] = []): LocalMemory {
  const next: LocalMemory = structuredClone(memory);
  const code = detectCode(memoryKey);
  const keys = Array.from(new Set([code, ...aliases.map((alias) => detectCode(alias))].filter(Boolean)));
  const confirmedFields = fields.map(savedField);

  for (const key of keys) {
    next.formulariosConocidos[key] = {
      fields: confirmedFields,
      vecesProcesado: (next.formulariosConocidos[key]?.vecesProcesado || 0) + 1
    };
  }

  for (const field of fields) {
    const baseX = Number(field.suggestedX ?? field.iaX ?? field.x);
    const baseY = Number(field.suggestedY ?? field.iaY ?? field.y);
    const dx = Number(field.x || 0) - baseX;
    const dy = Number(field.y || 0) - baseY;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      next.historialCorrecciones.push({
        fecha: new Date().toISOString().slice(0, 10),
        pdf: memoryKey,
        campo: field.nombre,
        dx,
        dy
      });
      const contexto = fieldContext(field);
      const pattern = next.patronesGlobales.find((item) => item.contexto === contexto);
      if (pattern) {
        const count = Math.max(0, pattern.vecesCorregido || 0);
        pattern.offsetX = (pattern.offsetX * count + dx) / (count + 1);
        pattern.offsetY = (pattern.offsetY * count + dy) / (count + 1);
        pattern.vecesCorregido = count + 1;
      } else {
        next.patronesGlobales.push({
          contexto,
          offsetX: dx,
          offsetY: dy,
          vecesAplicado: 0,
          vecesCorregido: 1
        });
      }
    } else {
      const contexto = fieldContext(field);
      const pattern = next.patronesGlobales.find((item) => item.contexto === contexto);
      if (pattern) pattern.vecesAplicado = (pattern.vecesAplicado || 0) + 1;
    }
  }

  saveMemory(next);
  return next;
}

export function detectCode(fileName: string): string {
  const input = String(fileName || "");
  const searchable = input.toUpperCase().replace(/[_\s]+/g, " ");
  const explicit = searchable.match(/\b[A-Z]{2,}-[A-Z0-9]{2,}-\d+[A-Z]?\b/);
  if (explicit) return normalizeFormCode(explicit[0]);

  const compactToken = searchable.match(/\bINZ[A-Z]{2,}\d+[A-Z]?\b/);
  if (compactToken) return normalizeFormCode(compactToken[0]);

  const spacedInz = searchable.match(/\bINZ\s*-?\s*[A-Z]{2,}\s*-?\s*\d+[A-Z]?\b/);
  if (spacedInz) return normalizeFormCode(spacedInz[0]);

  const compact = searchable.replace(/[^A-Z0-9]/g, "");
  const inzCompact = compact.match(/\bINZ[A-Z]{2,}\d+[A-Z]?\b/);
  if (inzCompact) return normalizeFormCode(inzCompact[0]);

  const firstUsefulLine = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstUsefulLine || input || "FORMULARIO")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 80);
}

function normalizeFormCode(code: string): string {
  const raw = String(code || "").toUpperCase().replace(/[_\s]+/g, "").replace(/-+/g, "-");
  if (raw.includes("-")) return raw;

  const inz = raw.match(/^(INZ)([A-Z]+?)(\d+[A-Z]?)$/);
  if (inz) return `${inz[1]}-${inz[2]}-${inz[3]}`;

  const generic = raw.match(/^([A-Z]{2,})([A-Z0-9]{2,})(\d+[A-Z]?)$/);
  if (generic) return `${generic[1]}-${generic[2]}-${generic[3]}`;

  return raw;
}

function normalize(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function fieldContext(field: PdfField): string {
  return `${field.tipo}:${normalize(field.nombre)}`;
}

export function applyMemoryOffsets(memory: LocalMemory, fields: PdfField[]): PdfField[] {
  return fields.map((field) => {
    if (field.source === "memoria") {
      return {
        ...field,
        iaX: field.x,
        iaY: field.y,
        suggestedX: field.x,
        suggestedY: field.y,
        confianza: Math.max(field.confianza, 0.92)
      };
    }

    const exactContext = fieldContext(field);
    const typeContext = field.tipo;
    const matches = memory.patronesGlobales.filter((pattern) => {
      const context = normalize(pattern.contexto);
      return context === exactContext || context.includes(exactContext) || context === typeContext;
    });

    if (!matches.length) {
      return {
        ...field,
        suggestedX: field.x,
        suggestedY: field.y
      };
    }

    const totals = matches.reduce(
      (acc, pattern) => {
        const weight = Math.max(1, (pattern.vecesAplicado || 0) + (pattern.vecesCorregido || 0));
        acc.x += pattern.offsetX * weight;
        acc.y += pattern.offsetY * weight;
        acc.weight += weight;
        return acc;
      },
      { x: 0, y: 0, weight: 0 }
    );

    const dx = totals.x / totals.weight;
    const dy = totals.y / totals.weight;

    return {
      ...field,
      x: Math.max(0, field.x + dx),
      y: Math.max(0, field.y + dy),
      suggestedX: Math.max(0, field.x + dx),
      suggestedY: Math.max(0, field.y + dy),
      confianza: Math.min(0.88, field.confianza + 0.12)
    };
  });
}
