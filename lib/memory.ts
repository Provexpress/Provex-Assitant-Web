import { normalize } from "./autocomplete";
import { LEGACY_MEMORY_SEED } from "./memorySeed";
import type { ContractorData, FormularioConocido, LocalMemory, PdfField } from "./types";

const STORAGE_KEY = "provex-assitant-web-memory-v1";

/** Umbral de veces procesado para considerar un formulario "aprendido" */
const LEARNED_THRESHOLD = 3;

// ── Conversión de semilla legacy ──────────────────────────────────

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

    const vecesProcesado = Number(form.veces_procesado || 0);
    formulariosConocidos[code] = {
      fields,
      vecesProcesado,
      aprendido: vecesProcesado >= LEARNED_THRESHOLD,
      ultimaVez: new Date().toISOString().slice(0, 10)
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

// ── Carga y persistencia ──────────────────────────────────────────

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

// ── Detección de código de formulario ────────────────────────────

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

// ── Estado de aprendizaje ─────────────────────────────────────────

/**
 * Retorna true si el formulario fue procesado >= LEARNED_THRESHOLD veces
 * Y fue marcado como aprendido (sin correcciones recientes que lo invaliden).
 * Cuando es true, el llamador puede saltarse la IA y usar la memoria directamente.
 */
export function isLearned(memory: LocalMemory, key: string): boolean {
  const form = memory.formulariosConocidos[key];
  if (!form) return false;
  return Boolean(form.aprendido) && (form.fields?.length ?? 0) > 0;
}

// ── Generación de hints para la IA ───────────────────────────────

/**
 * Genera hasta 8 hints de memoria para enviar a la IA como contexto.
 * Incluye correcciones históricas con etiqueta y offsets de patrones globales.
 */
export function memoryHints(memory: LocalMemory): string {
  const lines: string[] = [];

  // Top correcciones con etiqueta
  const topCorrections = memory.historialCorrecciones
    .filter((c) => Math.abs(c.dx) > 0.5 || Math.abs(c.dy) > 0.5)
    .slice(-12);

  if (topCorrections.length > 0) {
    lines.push("Correcciones históricas recientes:");
    for (const c of topCorrections) {
      const label = c.etiqueta ? `"${c.etiqueta}"` : `"${c.campo}"`;
      lines.push(`  - Campo ${label}: mover X ${c.dx.toFixed(1)}, Y ${c.dy.toFixed(1)}`);
    }
  }

  // Patrones globales más aplicados
  const topPatterns = memory.patronesGlobales
    .filter((p) => (p.vecesAplicado + p.vecesCorregido) > 1)
    .sort((a, b) => (b.vecesAplicado + b.vecesCorregido) - (a.vecesAplicado + a.vecesCorregido))
    .slice(0, 6);

  if (topPatterns.length > 0) {
    lines.push("Patrones de posición aprendidos:");
    for (const p of topPatterns) {
      lines.push(`  - ${p.contexto}: offset X ${p.offsetX.toFixed(1)}, Y ${p.offsetY.toFixed(1)}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "Sin memoria histórica relevante.";
}

// ── Aprendizaje desde confirmación ───────────────────────────────

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

function fieldContext(field: PdfField): string {
  return `${field.tipo}:${normalize(field.nombre)}`;
}

function compactMemoryValue(value: unknown): string {
  return normalize(value).replace(/[^a-z0-9]/g, "");
}

export function learnFromConfirmation(
  memory: LocalMemory,
  memoryKey: string,
  fields: PdfField[],
  aliases: string[] = []
): LocalMemory {
  const next: LocalMemory = structuredClone(memory);
  const code = detectCode(memoryKey);
  const keys = Array.from(new Set([code, ...aliases.map((alias) => detectCode(alias))].filter(Boolean)));
  const confirmedFields = fields.map(savedField);

  for (const key of keys) {
    const prevVeces = next.formulariosConocidos[key]?.vecesProcesado || 0;
    const nuevasVeces = prevVeces + 1;
    const formulario: FormularioConocido = {
      fields: confirmedFields,
      vecesProcesado: nuevasVeces,
      aprendido: nuevasVeces >= LEARNED_THRESHOLD,
      ultimaVez: new Date().toISOString().slice(0, 10)
    };
    next.formulariosConocidos[key] = formulario;
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
        dy,
        etiqueta: field.nombre,
        contexto: fieldContext(field)
      });

      // Actualizar patrón global
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

  // Limitar historial a las últimas 200 correcciones
  if (next.historialCorrecciones.length > 200) {
    next.historialCorrecciones = next.historialCorrecciones.slice(-200);
  }

  saveMemory(next);
  return next;
}

// ── Entrenamiento desde PDF ya rellenado ──────────────────────────

/**
 * Analiza campos que ya tienen valores del contratista y los guarda
 * como memoria exacta con confianza 0.99.
 *
 * Proceso:
 * 1. Para cada campo recibido, verifica si su valor coincide con
 *    algún dato del contratista (comparación normalizada).
 * 2. Los campos que coinciden se guardan como "aprendidos".
 * 3. Retorna { memory actualizada, camposAprendidos count }.
 */
export function trainFromFilledPdf(
  memory: LocalMemory,
  memoryKey: string,
  fields: PdfField[],
  contractorData: ContractorData
): { memory: LocalMemory; learned: number } {
  const next: LocalMemory = structuredClone(memory);

  // Construir mapa inverso: valor compacto → clave del contratista
  const inverseMap: Map<string, string> = new Map();
  for (const [key, value] of Object.entries(contractorData)) {
    const compact = compactMemoryValue(value);
    if (compact.length >= 4) {
      inverseMap.set(compact, key);
    }
  }

  let learned = 0;
  const trainedFields: PdfField[] = [];

  for (const field of fields) {
    const compactValue = compactMemoryValue(field.valor);
    let matchedKey: string | undefined =
      field.campoCsv && compactMemoryValue(contractorData[field.campoCsv]).length >= 4
        ? field.campoCsv
        : undefined;

    for (const [val, key] of inverseMap) {
      if (matchedKey) break;
      if (compactValue === val || (val.length >= 4 && compactValue.includes(val))) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) continue;

    learned++;
    trainedFields.push({
      ...field,
      source: "memoria",
      confianza: 0.99,
      campoCsv: matchedKey,
      iaX: field.x,
      iaY: field.y,
      suggestedX: field.x,
      suggestedY: field.y
    });
  }

  if (!trainedFields.length) {
    return { memory, learned: 0 };
  }

  const code = detectCode(memoryKey);
  if (code) {
    const prevVeces = next.formulariosConocidos[code]?.vecesProcesado || 0;
    next.formulariosConocidos[code] = {
      fields: trainedFields,
      vecesProcesado: Math.max(prevVeces, LEARNED_THRESHOLD), // Contar como ya aprendido
      aprendido: true,
      ultimaVez: new Date().toISOString().slice(0, 10)
    };
  }

  saveMemory(next);
  return { memory: next, learned };
}

// ── Aplicar offsets de memoria ────────────────────────────────────

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
