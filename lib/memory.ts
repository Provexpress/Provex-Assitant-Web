import { normalize } from "./autocomplete";
import { LEGACY_MEMORY_SEED } from "./memorySeed";
import type { ContractorData, FormularioConocido, LocalMemory, PatronGlobal, PdfField } from "./types";

const STORAGE_KEY = "provex-assitant-web-memory-v2";
const LEGACY_KEY = "provex-assitant-web-memory-v1";

/** Formulario se considera "aprendido" tras este número de confirmaciones */
const LEARNED_THRESHOLD = 3;

/** Número máximo de correcciones a conservar en historial */
const MAX_CORRECTIONS = 300;

/** Meses tras los cuales el peso de un patrón global se reduce a la mitad */
const DECAY_HALF_LIFE_MONTHS = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprinting de contenido
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera un fingerprint del texto del formulario basado en sus palabras clave.
 * Extrae títulos, encabezados y términos únicos para identificar el tipo de formulario
 * independientemente del nombre del archivo.
 *
 * @param text Texto extraído del PDF (primeras páginas)
 * @returns Clave canónica de 40-80 chars
 */
export function fingerprint(text: string): string {
  if (!text || text.trim().length < 20) return "";

  // Palabras a ignorar (stopwords comunes en formularios colombianos)
  const STOPWORDS = new Set([
    "de", "la", "el", "en", "y", "a", "los", "las", "un", "una", "con", "por",
    "para", "del", "al", "se", "su", "sus", "que", "no", "es", "son", "esta",
    "este", "como", "mas", "pero", "si", "o", "le", "lo", "fecha", "nombre",
    "empresa", "campo", "formulario", "pagina", "firma", "huella", "ciudad",
    "correo", "telefono", "direccion"
  ]);

  const words = normalize(text)
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  // Tomar las primeras 12 palabras más representativas (únicas)
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    keywords.push(w);
    if (keywords.length >= 12) break;
  }

  if (keywords.length < 3) return "";
  return keywords.slice(0, 8).sort().join("_");
}

/** Simplifica una clave numérica de formulario eliminando variaciones menores */
function normalizeFormCode(code: string): string {
  const raw = String(code || "").toUpperCase().replace(/[_\s]+/g, "").replace(/-+/g, "-");
  if (raw.includes("-")) return raw;

  const inz = raw.match(/^(INZ)([A-Z]+?)(\d+[A-Z]?)$/);
  if (inz) return `${inz[1]}-${inz[2]}-${inz[3]}`;

  const generic = raw.match(/^([A-Z]{2,})([A-Z0-9]{2,})(\d+[A-Z]?)$/);
  if (generic) return `${generic[1]}-${generic[2]}-${generic[3]}`;

  return raw;
}

/**
 * Detecta el código identificador de un formulario.
 * Estrategia en cascada:
 * 1. Patrón alfanumérico explícito (ej. INZ-PV-001)
 * 2. Primer token compacto tipo INZ
 * 3. Primera línea significativa del texto
 */
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
  const inzCompact = compact.match(/INZ[A-Z]{2,}\d+[A-Z]?/);
  if (inzCompact) return normalizeFormCode(inzCompact[0]);

  // Fallback: primera línea útil del texto, truncada
  const firstUsefulLine = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 3);
  return (firstUsefulLine || input || "FORMULARIO")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 80);
}

/**
 * Busca el mejor código de memoria para un formulario dado su nombre y texto.
 * Prioridad: código explícito > fingerprint de contenido > código de archivo
 */
export function findMemoryKey(
  memory: LocalMemory,
  fileName: string,
  pdfText: string
): string {
  // 1. Buscar por código explícito (nombre + texto combinados)
  const contentCode = detectCode(`${fileName}\n${pdfText}`);
  if (contentCode && memory.formulariosConocidos[contentCode]) {
    return contentCode;
  }

  // 2. Buscar por fingerprint del contenido
  const fp = fingerprint(pdfText);
  if (fp && memory.fingerprintIndex?.[fp]) {
    const fpKey = memory.fingerprintIndex[fp];
    if (memory.formulariosConocidos[fpKey]) return fpKey;
  }

  // 3. Buscar por nombre de archivo solo
  const fileCode = detectCode(fileName);
  if (fileCode && memory.formulariosConocidos[fileCode]) {
    return fileCode;
  }

  // 4. No encontrado: retornar el código más descriptivo para guardar
  return contentCode || fileCode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Carga y persistencia
// ─────────────────────────────────────────────────────────────────────────────

function legacyToLocalMemory(): LocalMemory {
  const legacy = LEGACY_MEMORY_SEED as unknown as {
    patrones_globales?: Array<Record<string, unknown>>;
    formularios_conocidos?: Record<string, {
      paginas?: Record<string, { campos?: Array<Record<string, unknown>> }>;
      veces_procesado?: number;
    }>;
    historial_correcciones?: Array<Record<string, unknown>>;
  };

  const formulariosConocidos: LocalMemory["formulariosConocidos"] = {};

  for (const [code, form] of Object.entries(legacy.formularios_conocidos || {})) {
    const fields: PdfField[] = [];
    for (const [pageText, page] of Object.entries(form.paginas || {})) {
      const pageNum = Number(pageText) || 0;
      for (const [index, field] of (page.campos || []).entries()) {
        const tipo = String(field.tipo || "texto") as PdfField["tipo"];
        const safeType: PdfField["tipo"] = ["texto", "checkbox", "firma", "huella"].includes(tipo) ? tipo : "texto";
        fields.push({
          id: `seed_${code}_${pageNum}_${index}`,
          pageNum,
          nombre: String(field.nombre || "Campo"),
          valor: String(field.valor || ""),
          tipo: safeType,
          x: Number(field.x || 0),
          y: Number(field.y || 0),
          w: Number(field.w || (safeType === "firma" ? 100 : safeType === "huella" ? 60 : 120)),
          h: Number(field.h || (safeType === "firma" ? 40 : safeType === "huella" ? 80 : 22)),
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
      ultimaVez: new Date().toISOString().slice(0, 10),
      formVersion: 1
    };
  }

  return {
    version: 2,
    patronesGlobales: (legacy.patrones_globales || []).map((p) => ({
      contexto: String(p.contexto || ""),
      offsetX: Number(p.offset_x || 0),
      offsetY: Number(p.offset_y || 0),
      vecesAplicado: Number(p.veces_aplicado || 0),
      vecesCorregido: Number(p.veces_corregido || 0)
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
    }),
    fingerprintIndex: {}
  };
}

export function loadMemory(): LocalMemory {
  if (typeof window === "undefined") return legacyToLocalMemory();

  // Intentar cargar versión actual
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LocalMemory;
      // Asegurar que tenga fingerprintIndex
      if (!parsed.fingerprintIndex) parsed.fingerprintIndex = {};
      return parsed;
    } catch { /* fall through */ }
  }

  // Intentar migrar desde versión anterior
  const oldRaw = window.localStorage.getItem(LEGACY_KEY);
  if (oldRaw) {
    try {
      const old = JSON.parse(oldRaw) as LocalMemory;
      const migrated: LocalMemory = { ...old, version: 2, fingerprintIndex: {} };
      // Añadir campos faltantes a patrones
      migrated.patronesGlobales = (old.patronesGlobales || []).map((p) => ({ ...p }));
      saveMemory(migrated);
      return migrated;
    } catch { /* fall through */ }
  }

  // Semilla por defecto
  const seeded = legacyToLocalMemory();
  saveMemory(seeded);
  return seeded;
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

// ─────────────────────────────────────────────────────────────────────────────
// Estado de aprendizaje
// ─────────────────────────────────────────────────────────────────────────────

export function isLearned(memory: LocalMemory, key: string): boolean {
  const form = memory.formulariosConocidos[key];
  if (!form) return false;
  return Boolean(form.aprendido) && (form.fields?.length ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decaimiento de patrones
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calcula el peso efectivo de un patrón global considerando su antigüedad.
 * Patrones recientes tienen peso completo; los viejos se reducen gradualmente.
 */
function decayedWeight(pattern: PatronGlobal): number {
  const base = Math.max(1, (pattern.vecesAplicado || 0) + (pattern.vecesCorregido || 0));
  if (!pattern.ultimaVez) return base;

  const ageDays = (Date.now() - new Date(pattern.ultimaVez).getTime()) / (1000 * 60 * 60 * 24);
  const ageMonths = ageDays / 30;
  const halfLifes = ageMonths / DECAY_HALF_LIFE_MONTHS;
  const decay = Math.pow(0.5, halfLifes);

  return base * decay;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generación de hints para la IA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera contexto enriquecido para enviar a la IA.
 * Incluye correcciones específicas del formulario actual, patrones globales con decay,
 * y un resumen de los campos ya aprendidos para ese formulario.
 */
export function memoryHints(memory: LocalMemory, formKey = ""): string {
  const lines: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // 1. Resumen del formulario conocido
  if (formKey && memory.formulariosConocidos[formKey]) {
    const form = memory.formulariosConocidos[formKey];
    lines.push(`Formulario reconocido: "${formKey}" (procesado ${form.vecesProcesado} veces, último: ${form.ultimaVez || "?"}).`);
    const camposResumen = form.fields
      .filter((f) => f.campoCsv && f.tipo === "texto")
      .slice(0, 6)
      .map((f) => `"${f.nombre}" → ${f.campoCsv} (x:${f.x}, y:${f.y})`)
      .join("; ");
    if (camposResumen) lines.push(`Campos conocidos: ${camposResumen}.`);
  }

  // 2. Correcciones específicas del formulario (scope)
  const formCorrections = memory.historialCorrecciones
    .filter((c) => (!formKey || c.formKey === formKey || c.pdf === formKey) && (Math.abs(c.dx) > 1 || Math.abs(c.dy) > 1))
    .slice(-8);

  if (formCorrections.length > 0) {
    lines.push("Correcciones previas en este formulario:");
    for (const c of formCorrections) {
      const label = c.etiqueta ? `"${c.etiqueta}"` : `"${c.campo}"`;
      lines.push(`  - ${label}: dx=${c.dx.toFixed(1)}, dy=${c.dy.toFixed(1)}`);
    }
  }

  // 3. Patrones globales con mejor peso (con decaimiento)
  const topPatterns = [...memory.patronesGlobales]
    .map((p) => ({ p, w: decayedWeight(p) }))
    .filter(({ w }) => w > 0.5)
    .sort((a, b) => b.w - a.w)
    .slice(0, 5);

  if (topPatterns.length > 0) {
    lines.push("Patrones de posición aprendidos (globales):");
    for (const { p } of topPatterns) {
      if (Math.abs(p.offsetX) > 0.5 || Math.abs(p.offsetY) > 0.5) {
        lines.push(`  - ${p.contexto}: dx=${p.offsetX.toFixed(1)}, dy=${p.offsetY.toFixed(1)}`);
      }
    }
  }

  lines.push(`Fecha de hoy: ${today}`);

  const result = lines.join("\n");
  // Limitar a 2000 chars para no saturar el contexto de la IA
  return result.slice(0, 2000) || "Sin memoria histórica relevante.";
}

// ─────────────────────────────────────────────────────────────────────────────
// Aprendizaje desde confirmación (merge inteligente)
// ─────────────────────────────────────────────────────────────────────────────

function savedField(field: PdfField): PdfField {
  return {
    ...field,
    source: "memoria",
    confianza: Math.min(0.99, Math.max(0.92, field.confianza + 0.08)),
    iaX: field.x,
    iaY: field.y,
    suggestedX: field.x,
    suggestedY: field.y,
    lastConfirmed: new Date().toISOString().slice(0, 10)
  };
}

function fieldContext(field: PdfField): string {
  return `${field.tipo}:${normalize(field.nombre)}`;
}

/**
 * Merge inteligente de campos:
 * - Si ya existe un campo con misma clave CSV y misma página, actualizar posición.
 * - Si es nuevo, agregarlo.
 * - Preservar campos aprendidos que el usuario no confirmó (pueden estar en otra página).
 */
function mergeFields(existing: PdfField[], confirmed: PdfField[]): PdfField[] {
  const result = [...existing];
  const today = new Date().toISOString().slice(0, 10);

  for (const field of confirmed) {
    const idx = result.findIndex((e) => {
      if (e.pageNum !== field.pageNum) return false;
      if (e.campoCsv && field.campoCsv && e.campoCsv === field.campoCsv) return true;
      if (normalize(e.nombre) === normalize(field.nombre)) return true;
      return Math.abs(e.x - field.x) < 15 && Math.abs(e.y - field.y) < 15;
    });

    const saved = { ...savedField(field), lastConfirmed: today };

    if (idx === -1) {
      result.push(saved);
    } else {
      // Actualizar posición y valor; conservar ID original
      result[idx] = { ...result[idx], ...saved, id: result[idx].id };
    }
  }

  return result;
}

export function learnFromConfirmation(
  memory: LocalMemory,
  memoryKey: string,
  fields: PdfField[],
  aliases: string[] = [],
  pdfText = ""
): LocalMemory {
  const next: LocalMemory = structuredClone(memory);
  if (!next.fingerprintIndex) next.fingerprintIndex = {};

  const code = detectCode(memoryKey);
  const keys = Array.from(new Set([code, ...aliases.map(detectCode)].filter(Boolean)));
  const today = new Date().toISOString().slice(0, 10);
  const fp = fingerprint(pdfText);

  for (const key of keys) {
    const prevForm = next.formulariosConocidos[key];
    const prevVeces = prevForm?.vecesProcesado || 0;
    const nuevasVeces = prevVeces + 1;

    // Merge inteligente: no sobreescribir sino fusionar
    const mergedFields = prevForm?.fields?.length
      ? mergeFields(prevForm.fields, fields.map(savedField))
      : fields.map(savedField);

    const formulario: FormularioConocido = {
      fields: mergedFields,
      vecesProcesado: nuevasVeces,
      aprendido: nuevasVeces >= LEARNED_THRESHOLD,
      ultimaVez: today,
      structureHash: fp || prevForm?.structureHash,
      formVersion: 1
    };
    next.formulariosConocidos[key] = formulario;

    // Registrar fingerprint → clave en el índice
    if (fp) next.fingerprintIndex[fp] = key;
  }

  // Actualizar patrones de posición
  for (const field of fields) {
    const baseX = Number(field.suggestedX ?? field.iaX ?? field.x);
    const baseY = Number(field.suggestedY ?? field.iaY ?? field.y);
    const dx = Number(field.x || 0) - baseX;
    const dy = Number(field.y || 0) - baseY;

    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      next.historialCorrecciones.push({
        fecha: today,
        pdf: memoryKey,
        campo: field.nombre,
        dx,
        dy,
        etiqueta: field.nombre,
        contexto: fieldContext(field),
        formKey: code
      });

      // Patrón global scoped
      const contexto = fieldContext(field);
      const pattern = next.patronesGlobales.find(
        (p) => p.contexto === contexto && (!p.formKey || p.formKey === code)
      );

      if (pattern) {
        const count = Math.max(0, pattern.vecesCorregido || 0);
        pattern.offsetX = (pattern.offsetX * count + dx) / (count + 1);
        pattern.offsetY = (pattern.offsetY * count + dy) / (count + 1);
        pattern.vecesCorregido = count + 1;
        pattern.ultimaVez = today;
      } else {
        next.patronesGlobales.push({
          contexto,
          offsetX: dx,
          offsetY: dy,
          vecesAplicado: 0,
          vecesCorregido: 1,
          ultimaVez: today,
          formKey: code
        });
      }
    } else {
      const contexto = fieldContext(field);
      const pattern = next.patronesGlobales.find((p) => p.contexto === contexto);
      if (pattern) {
        pattern.vecesAplicado = (pattern.vecesAplicado || 0) + 1;
        pattern.ultimaVez = today;
      }
    }
  }

  // Limpiar historial excesivo
  if (next.historialCorrecciones.length > MAX_CORRECTIONS) {
    next.historialCorrecciones = next.historialCorrecciones.slice(-MAX_CORRECTIONS);
  }

  // Limpiar patrones con peso decaído a cero (más de 2 años sin uso)
  next.patronesGlobales = next.patronesGlobales.filter((p) => decayedWeight(p) > 0.05);

  saveMemory(next);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrenamiento desde PDF ya rellenado
// ─────────────────────────────────────────────────────────────────────────────

function compactMemoryValue(value: unknown): string {
  return normalize(value).replace(/[^a-z0-9]/g, "");
}

export function trainFromFilledPdf(
  memory: LocalMemory,
  memoryKey: string,
  fields: PdfField[],
  contractorData: ContractorData,
  pdfText = ""
): { memory: LocalMemory; learned: number } {
  const next: LocalMemory = structuredClone(memory);
  if (!next.fingerprintIndex) next.fingerprintIndex = {};

  // Construir mapa inverso: valor compacto → clave del contratista
  const inverseMap: Map<string, string> = new Map();
  for (const [key, value] of Object.entries(contractorData)) {
    const compact = compactMemoryValue(value);
    if (compact.length >= 4) inverseMap.set(compact, key);
  }

  let learned = 0;
  const trainedFields: PdfField[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const field of fields) {
    // Los campos de firma/huella siempre se aprenden
    if (field.tipo === "firma" || field.tipo === "huella") {
      learned++;
      trainedFields.push({ ...field, source: "memoria", confianza: 0.97, lastConfirmed: today });
      continue;
    }

    const compactValue = compactMemoryValue(field.valor);
    let matchedKey = field.campoCsv && compactMemoryValue(contractorData[field.campoCsv]).length >= 4
      ? field.campoCsv
      : undefined;

    if (!matchedKey) {
      for (const [val, key] of inverseMap) {
        if (compactValue === val || (val.length >= 5 && compactValue.includes(val))) {
          matchedKey = key;
          break;
        }
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
      suggestedY: field.y,
      lastConfirmed: today
    });
  }

  if (!trainedFields.length) return { memory, learned: 0 };

  const code = detectCode(memoryKey);
  const fp = fingerprint(pdfText);

  if (code) {
    const prev = next.formulariosConocidos[code];
    const mergedFields = prev?.fields?.length
      ? mergeFields(prev.fields, trainedFields)
      : trainedFields;

    next.formulariosConocidos[code] = {
      fields: mergedFields,
      vecesProcesado: Math.max(prev?.vecesProcesado || 0, LEARNED_THRESHOLD),
      aprendido: true,
      ultimaVez: today,
      structureHash: fp || prev?.structureHash,
      formVersion: 1
    };

    if (fp) next.fingerprintIndex[fp] = code;
  }

  saveMemory(next);
  return { memory: next, learned };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aplicar offsets de memoria (con scope por formulario)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aplica los offsets de corrección aprendidos a los campos detectados por IA.
 * Prioridad: patrones específicos del formulario > patrones globales con decaimiento.
 */
export function applyMemoryOffsets(memory: LocalMemory, fields: PdfField[], formKey = ""): PdfField[] {
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

    // 1. Buscar patrón específico del formulario actual (máxima prioridad)
    const scopedPatterns = memory.patronesGlobales.filter(
      (p) => p.formKey === formKey && normalize(p.contexto) === exactContext
    );

    // 2. Buscar patrones globales sin scope
    const globalPatterns = memory.patronesGlobales.filter(
      (p) => !p.formKey && normalize(p.contexto) === exactContext
    );

    const matches = scopedPatterns.length > 0 ? scopedPatterns : globalPatterns;

    if (!matches.length) {
      return { ...field, suggestedX: field.x, suggestedY: field.y };
    }

    const totals = matches.reduce(
      (acc, p) => {
        const w = decayedWeight(p);
        acc.x += p.offsetX * w;
        acc.y += p.offsetY * w;
        acc.weight += w;
        return acc;
      },
      { x: 0, y: 0, weight: 0 }
    );

    if (totals.weight === 0) return { ...field, suggestedX: field.x, suggestedY: field.y };

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
