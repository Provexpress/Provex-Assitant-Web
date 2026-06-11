import type { ContractorData, FieldType, PdfField } from "./types";

// ── Normalización ─────────────────────────────────────────────────
export function normalize(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ── Formateo y validación de datos ───────────────────────────────

/** Formatea NIT colombiano → XXX.XXX.XXX-X */
export function formatNit(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return raw;
  const body = digits.slice(0, -1);
  const dv = digits.slice(-1);
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${grouped}-${dv}`;
}

/** Limpia cédula / CE: solo alfanumérico con espacios */
export function formatCC(raw: string): string {
  return raw.replace(/[^A-Z0-9 .]/gi, "").trim();
}

/** Solo dígitos para teléfono */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/[^0-9+]/g, "");
  return digits || raw;
}

/** Correo en minúsculas */
export function formatEmail(raw: string): string {
  return raw.toLowerCase().trim();
}

/** Fecha colombiana dd/mm/aaaa */
export function formatDate(raw: string): string {
  // Si ya tiene formato dd/mm/aaaa o dd-mm-aaaa, respetar
  if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(raw.trim())) {
    return raw.replace(/-/g, "/");
  }
  // Si tiene formato aaaa-mm-dd (ISO)
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  // Devolver sin cambiar si no reconocemos
  return raw;
}

/** Valida que el correo tenga @ */
export function isValidEmail(value: string): boolean {
  return value.includes("@") && value.includes(".");
}

/** Aplica el formateador correcto según la clave del campo */
function applyFormat(key: string, value: string): string {
  if (!value || value === "[SIN DATO]") return value;
  if (key === "nit") return formatNit(value);
  if (key === "documento_identidad" || key === "cc") return formatCC(value);
  if (key === "telefono" || key === "celular") return formatPhone(value);
  if (key === "correo_contacto" || key === "correo" || key === "email") return formatEmail(value);
  if (key === "fecha" || key === "fecha_hoy" || key === "ciudad_fecha" || key === "ciudad_y_fecha") {
    return formatDate(value);
  }
  return value;
}

// ── Mapa de aliases ───────────────────────────────────────────────
/**
 * Cada entrada: [[aliases...], clave_contratista, tipo]
 * Orden de importancia: los más específicos primero.
 */
const intelligentMap: Array<[string[], string, FieldType]> = [
  // ── Fecha y ciudad/fecha ──────────────────────────────────────
  [
    [
      "ciudad y fecha", "ciudad y fecha:", "lugar y fecha", "lugar y fecha:",
      "ciudad, fecha", "fecha y ciudad", "en la ciudad"
    ],
    "ciudad_fecha", "texto"
  ],
  [
    [
      "fecha de diligenciamiento", "fecha registro", "fecha de registro",
      "fecha de suscripcion", "fecha expedicion", "fecha:",
      "fecha de", "a los dias del mes de", "fecha"
    ],
    "fecha", "texto"
  ],

  // ── Razón social ──────────────────────────────────────────────
  [
    [
      "tercero a evaluar", "razon social", "razon o denominacion social",
      "denominacion social", "nombre de la empresa", "nombre empresa",
      "en representacion de", "actuando en nombre de", "nombre o razon",
      "nombre del proveedor", "proveedor", "empresa", "tercero", "entidad"
    ],
    "razon_social", "texto"
  ],

  // ── NIT ───────────────────────────────────────────────────────
  [
    [
      "n.i.t.", "n.i.t", "nit no", "nit:", "nit ",
      "identificacion tributaria", "identificada con nit",
      "identificado con nit", "numero de nit", "con nit", "rut", "nit"
    ],
    "nit", "texto"
  ],

  // ── Representante legal ───────────────────────────────────────
  [
    [
      "representante legal", "rep. legal", "rep legal",
      "nombre del representante", "nombre de quien diligencia",
      "quien suscribe", "el suscrito", "yo,", "suscrito",
      "nombres y apellidos", "nombre completo del", "nombre completo",
      "nombre:", "nombre del titular"
    ],
    "representante_legal", "texto"
  ],

  // ── Documento de identidad ────────────────────────────────────
  [
    [
      "cedula de ciudadania", "cedula de ciudadanía", "c.c.:", "c.c:",
      "portador de la cedula", "identificado con cedula",
      "identificado con cc", "identificada con cc",
      "identificado con c.c", "numero de cedula",
      "documento de identidad", "documento identidad",
      "cedula", "c.c", "cc.", "cc "
    ],
    "documento_identidad", "texto"
  ],

  // ── Dirección ─────────────────────────────────────────────────
  [
    [
      "direccion principal", "direccion de correspondencia",
      "domicilio principal", "sede principal", "ubicada en",
      "con domicilio en", "domicilio", "direccion"
    ],
    "direccion", "texto"
  ],

  // ── Ciudad ────────────────────────────────────────────────────
  [["ciudad:", "municipio", "ciudad"], "ciudad", "texto"],

  // ── Departamento ─────────────────────────────────────────────
  [["departamento:", "departamento"], "departamento", "texto"],

  // ── País ─────────────────────────────────────────────────────
  [["pais:", "pais"], "pais", "texto"],

  // ── Teléfono ─────────────────────────────────────────────────
  [
    ["telefono principal", "pbx", "fax", "telefono:", "tel.:", "tel:", "tel ", "telefono"],
    "telefono", "texto"
  ],

  // ── Celular ───────────────────────────────────────────────────
  [["celular:", "movil:", "celular", "movil"], "celular", "texto"],

  // ── Correo ────────────────────────────────────────────────────
  [
    [
      "correo electronico", "correo electrónico", "e-mail:", "email:",
      "correo:", "correo"
    ],
    "correo_contacto", "texto"
  ],

  // ── Actividad económica ───────────────────────────────────────
  [["actividad economica", "codigo ciiu", "ciiu", "actividad principal"], "actividad_economica", "texto"],

  // ── Régimen tributario ────────────────────────────────────────
  [["regimen tributario", "regimen:", "regimen"], "regimen_tributario", "texto"],

  // ── Responsable IVA ──────────────────────────────────────────
  [["responsable de iva", "responsable iva"], "responsable_iva", "texto"],

  // ── Gran contribuyente ────────────────────────────────────────
  [["gran contribuyente"], "gran_contribuyente", "texto"],

  // ── Autorretenedor ────────────────────────────────────────────
  [["autorretenedor renta", "autorretenedor"], "autorretenedor_renta", "texto"],

  // ── Tamaño empresa ────────────────────────────────────────────
  [["tamano empresa", "tipo empresa", "clasificacion empresa", "tamano de empresa"], "tamano_empresa", "texto"],

  // ── Firma ─────────────────────────────────────────────────────
  [["firma digital", "firma autorizada", "firma:", "firma"], "firma", "firma"],

  // ── Huella ────────────────────────────────────────────────────
  [["huella dactilar", "huella digital", "huella:", "huella"], "huella", "huella"]
];

// ── Motor de mapeo ────────────────────────────────────────────────

export function matchField(name: string): { key: string; type: FieldType } | null {
  const normalized = normalize(name);
  let best: { key: string; type: FieldType; score: number } | null = null;

  for (const [patterns, key, type] of intelligentMap) {
    for (const pattern of patterns) {
      const needle = normalize(pattern);
      if (!needle) continue;

      // Coincidencia exacta tiene prioridad máxima
      if (normalized === needle) {
        return { key, type };
      }

      // Coincidencia por inclusión: preferir la más larga (más específica)
      if (normalized.includes(needle) && (!best || needle.length > best.score)) {
        best = { key, type, score: needle.length };
      }
    }
  }

  return best ? { key: best.key, type: best.type } : null;
}

// ── Autocompletado individual ─────────────────────────────────────

export function autocompleteField(field: PdfField, contractorData: ContractorData): PdfField {
  const match = matchField(field.nombre);

  if (!match) {
    // Si ya tiene valor, dejarlo; si no, marcarlo vacío pero no con texto inventado
    return field;
  }

  if (match.type === "firma" || match.type === "huella") {
    return { ...field, tipo: match.type, valor: match.type, campoCsv: match.key };
  }

  if (field.tipo === "checkbox") {
    const value = normalize(contractorData[match.key] || "");
    const fieldName = normalize(field.nombre);
    // Marcar si el valor del contratista es "si"/"x" o si el campo dice "no" y el valor es "no"
    const checked =
      value === "si" || value === "x" || value === "true" ||
      (fieldName.includes("no") && (value === "no" || value === "false"));
    return { ...field, valor: checked ? "X" : "", campoCsv: match.key };
  }

  const rawValue = contractorData[match.key] || "";
  if (!rawValue) return field; // No sobrescribir con vacío

  const formattedValue = applyFormat(match.key, rawValue);

  // Nivel de confianza: si el campo ya tenía valor de la IA, combinar;
  // si viene de zona detectada (confianza >= 0.6), subir ligeramente
  const newConfianza = Math.min(0.99, field.confianza + 0.05);

  return {
    ...field,
    tipo: "texto",
    valor: formattedValue,
    campoCsv: match.key,
    confianza: newConfianza
  };
}

// ── Autocompletado masivo ─────────────────────────────────────────

export function autocompleteFields(fields: PdfField[], contractorData: ContractorData): PdfField[] {
  return fields.map((field) => autocompleteField(field, contractorData));
}

// ── Deduplicación robusta ─────────────────────────────────────────

/**
 * Elimina campos duplicados basándose en:
 * 1. Misma página + posición cercana (±12 pts) + mismo tipo → mantener mayor confianza
 * 2. Misma página + nombre normalizado idéntico → mantener mayor confianza
 */
export function deduplicateFields(fields: PdfField[]): PdfField[] {
  const result: PdfField[] = [];

  for (const field of fields) {
    const normalizedName = normalize(field.nombre);

    // Buscar si ya existe uno solapado
    const existingIndex = result.findIndex((existing) => {
      if (existing.pageNum !== field.pageNum) return false;

      // Duplicado por nombre normalizado
      if (normalize(existing.nombre) === normalizedName && normalizedName.length > 2) {
        return true;
      }

      // Duplicado por posición cercana + mismo tipo
      const dx = Math.abs(existing.x - field.x);
      const dy = Math.abs(existing.y - field.y);
      if (dx <= 12 && dy <= 12 && existing.tipo === field.tipo) {
        return true;
      }

      return false;
    });

    if (existingIndex === -1) {
      result.push(field);
    } else {
      // Mantener el de mayor confianza
      if (field.confianza > result[existingIndex].confianza) {
        result[existingIndex] = field;
      }
    }
  }

  return result;
}

/**
 * Determina si un campo debe mostrarse vacío al usuario (confianza baja)
 * o si puede rellenarse automáticamente.
 *
 * confianza >= 0.8 → relleno automático, borde verde
 * 0.5 <= confianza < 0.8 → relleno pero marcado amarillo (ya lo hace el CSS)
 * confianza < 0.5 → dejarlo vacío si no tiene valor
 */
export function shouldAutoFill(field: PdfField): boolean {
  return field.confianza >= 0.5 && Boolean(field.valor);
}
