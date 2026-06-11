import type { ContractorData, FieldType, PdfField } from "./types";

type Mapping = {
  key: string;
  type: FieldType;
  patterns: string[];
};

type CheckboxConcept = {
  key: string;
  patterns: string[];
  mark: (data: ContractorData) => boolean;
};

export type AutocompleteSummary = {
  total: number;
  completed: number;
  autoCompleted: number;
  needsReview: number;
  missing: number;
  checkboxes: number;
  images: number;
  percent: number;
};

export function normalize(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isYes(value: unknown): boolean {
  return ["si", "sí", "x", "true", "1", "yes"].includes(normalize(value));
}

function isNo(value: unknown): boolean {
  return ["no", "false", "0"].includes(normalize(value));
}

function hasWord(haystack: string, word: string): boolean {
  return new RegExp(`(^|\\s)${word}(\\s|$)`).test(haystack);
}

function matchesPattern(haystack: string, pattern: string): boolean {
  if (!haystack) return false;

  if (pattern.includes(".*")) {
    const parts = pattern.split(".*").map(normalize).filter(Boolean);
    let from = 0;
    for (const part of parts) {
      const index = haystack.indexOf(part, from);
      if (index < 0) return false;
      from = index + part.length;
    }
    return true;
  }

  const needle = normalize(pattern);
  if (!needle) return false;
  return haystack.includes(needle) || (needle.includes(haystack) && haystack.length >= 5);
}

export function formatNit(raw: string): string {
  const clean = raw.trim();
  if (!clean) return clean;
  if (/\d{1,3}(\.\d{3})+-\d$/u.test(clean)) return clean;

  const digits = clean.replace(/[^0-9]/g, "");
  if (digits.length < 2) return clean;
  const body = digits.slice(0, -1);
  const dv = digits.slice(-1);
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv}`;
}

export function formatCC(raw: string): string {
  return raw.replace(/[^A-Z0-9 .-]/gi, "").trim();
}

export function formatPhone(raw: string): string {
  const digits = raw.replace(/[^0-9+]/g, "");
  return digits || raw;
}

export function formatEmail(raw: string): string {
  return raw.toLowerCase().trim();
}

export function formatDate(raw: string): string {
  const clean = raw.trim();
  if (/^\d{2}[/-]\d{2}[/-]\d{4}$/.test(clean)) return clean.replace(/-/g, "/");
  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return clean;
}

export function isValidEmail(value: string): boolean {
  return value.includes("@") && value.includes(".");
}

function contractorValue(data: ContractorData, key: string): string {
  const aliases: Record<string, string[]> = {
    documento_identidad: ["documento_identidad", "cc", "cedula"],
    correo_contacto: ["correo_contacto", "correo", "email"],
    fecha: ["fecha", "fecha_hoy"],
    ciudad_fecha: ["ciudad_fecha", "ciudad_y_fecha"],
    telefono: ["telefono", "telefono_contacto"]
  };

  const keys = aliases[key] || [key];
  for (const candidate of keys) {
    const value = String(data[candidate] || "").trim();
    if (value) return applyFormat(key, value);
  }
  return "";
}

function applyFormat(key: string, value: string): string {
  if (!value || value === "[SIN DATO]") return value;
  if (key === "nit") return formatNit(value);
  if (key === "documento_identidad" || key === "cc") return formatCC(value);
  if (key === "telefono" || key === "celular") return formatPhone(value);
  if (key === "correo_contacto" || key === "correo" || key === "email") return formatEmail(value);
  if (key === "fecha" || key === "fecha_hoy") return formatDate(value);
  return value;
}

const FIELD_MAPPINGS: Mapping[] = [
  {
    key: "ciudad_fecha",
    type: "texto",
    patterns: ["ciudad y fecha", "ciudad fecha", "lugar y fecha", "lugar fecha", "fecha y ciudad"]
  },
  {
    key: "fecha",
    type: "texto",
    patterns: [
      "fecha",
      "fecha registro",
      "fecha de registro",
      "fecha diligenciamiento",
      "fecha del formulario",
      "fecha radicacion",
      "fecha de radicacion",
      "fecha de suscripcion",
      "fecha expedicion",
      "a los dias del mes"
    ]
  },
  {
    key: "razon_social",
    type: "texto",
    patterns: [
      "razon social",
      "razon o denominacion social",
      "empresa",
      "nombre empresa",
      "nombre de la empresa",
      "denominacion social",
      "tercero a evaluar",
      "tercero",
      "contratista",
      "nombre o razon",
      "obrando en representacion de",
      "en representacion de",
      "de la empresa",
      "proveedor",
      "proveedor de servicios",
      "nombre del contratista",
      "nombre del tercero",
      "entidad"
    ]
  },
  {
    key: "nit",
    type: "texto",
    patterns: [
      "nit",
      "n i t",
      "nit no",
      "identificacion tributaria",
      "identificada con nit",
      "identificado con nit",
      "numero de nit",
      "numero de identificacion tributaria",
      "id tributaria",
      "rut"
    ]
  },
  {
    key: "representante_legal",
    type: "texto",
    patterns: [
      "representante legal",
      "rep legal",
      "representante",
      "nombre del representante",
      "yo",
      "el abajo firmante",
      "nombre de quien diligencia",
      "nombre funcionario",
      "nombre completo",
      "nombres y apellidos",
      "suscrito",
      "firmante",
      "otorgante",
      "apoderado",
      "quien suscribe"
    ]
  },
  {
    key: "documento_identidad",
    type: "texto",
    patterns: [
      "cedula",
      "c c",
      "cc",
      "documento identidad",
      "documento de identidad",
      "no identificacion",
      "identificado con",
      "identificada con",
      "numero documento",
      "doc identidad",
      "cedula de ciudadania",
      "no cedula",
      "cedula no"
    ]
  },
  {
    key: "direccion",
    type: "texto",
    patterns: [
      "direccion",
      "direccion comercial",
      "domicilio",
      "direccion principal",
      "direccion de correspondencia",
      "sede principal",
      "ubicacion",
      "ubicada en",
      "con domicilio en"
    ]
  },
  { key: "ciudad", type: "texto", patterns: ["ciudad domicilio", "ciudad", "municipio"] },
  { key: "departamento", type: "texto", patterns: ["departamento", "provincia", "estado"] },
  { key: "pais", type: "texto", patterns: ["pais", "nacionalidad"] },
  {
    key: "telefono",
    type: "texto",
    patterns: [
      "telefono",
      "telefono fijo",
      "telefono principal",
      "numero telefonico",
      "tel",
      "pbx",
      "fax"
    ]
  },
  { key: "celular", type: "texto", patterns: ["celular", "movil", "telefono celular", "numero celular", "cel"] },
  {
    key: "correo_contacto",
    type: "texto",
    patterns: [
      "correo",
      "correo electronico",
      "email",
      "e mail",
      "e-mail",
      "direccion electronica"
    ]
  },
  {
    key: "actividad_economica",
    type: "texto",
    patterns: ["actividad economica", "ciiu", "codigo ciiu", "actividad principal", "actividad comercial"]
  },
  {
    key: "regimen_tributario",
    type: "texto",
    patterns: ["regimen", "regimen tributario", "tipo regimen"]
  },
  { key: "responsable_iva", type: "texto", patterns: ["responsable iva", "responsable de iva"] },
  { key: "gran_contribuyente", type: "texto", patterns: ["gran contribuyente"] },
  { key: "autorretenedor_renta", type: "texto", patterns: ["autorretenedor renta", "autorretenedor", "retencion fuente"] },
  {
    key: "tamano_empresa",
    type: "texto",
    patterns: ["tamano empresa", "tamano de empresa", "tipo empresa", "clasificacion empresa", "mediana empresa"]
  },
  { key: "firma", type: "firma", patterns: ["firma digital", "firma autorizada", "firma representante", "firma"] },
  { key: "huella", type: "huella", patterns: ["huella dactilar", "huella digital", "huella"] }
];

const CHECKBOX_CONCEPTS: CheckboxConcept[] = [
  { key: "proveedor", patterns: ["proveedor", "proveedor bienes", "proveedor servicios"], mark: () => true },
  { key: "cliente", patterns: ["cliente"], mark: () => false },
  { key: "responsable_iva", patterns: ["responsable iva", "responsable de iva", "responsable del impuesto"], mark: (d) => isYes(d.responsable_iva) },
  { key: "gran_contribuyente", patterns: ["gran contribuyente"], mark: (d) => isYes(d.gran_contribuyente) },
  { key: "autorretenedor_renta", patterns: ["autorretenedor", "retencion fuente", "retenedor"], mark: (d) => isYes(d.autorretenedor_renta) },
  { key: "sas", patterns: ["sociedad anonima simplificada", "s a s", "sas"], mark: () => true },
  { key: "regimen_comun", patterns: ["regimen comun", "comun"], mark: (d) => ["ordinario", "comun"].includes(normalize(d.regimen_tributario)) },
  { key: "regimen_simplificado", patterns: ["regimen simplificado", "simplificado"], mark: () => false },
  { key: "mediana", patterns: ["mediana"], mark: (d) => normalize(d.tamano_empresa).includes("mediana") },
  { key: "corporacion_sin_animo", patterns: ["corporacion", "fundacion", "sin animo de lucro", "entidad sin animo"], mark: () => false },
  { key: "pep", patterns: ["persona publicamente expuesta", "publicamente expuesta", "pep"], mark: () => false },
  { key: "moneda_virtual", patterns: ["moneda virtual", "criptoactivo", "criptomoneda"], mark: () => false },
  { key: "casas_cambio", patterns: ["casas de cambio"], mark: () => false },
  { key: "casas_empeno", patterns: ["casas de empeno"], mark: () => false },
  { key: "casinos", patterns: ["casinos", "apuestas", "juegos de azar"], mark: () => false },
  { key: "vehiculos", patterns: ["vehiculos", "embarcaciones"], mark: () => false },
  { key: "multinivel", patterns: ["multinivel", "piramidal"], mark: () => false },
  { key: "armas", patterns: ["armas", "explosivos", "municiones"], mark: () => false },
  { key: "constructoras", patterns: ["constructoras", "construccion"], mark: () => false },
  { key: "bienes_raices", patterns: ["bienes raices", "inmobiliaria"], mark: () => false },
  { key: "deportivas", patterns: ["deportivas", "club deportivo"], mark: () => false },
  { key: "gasolina", patterns: ["gasolina", "estaciones de servicio"], mark: () => false },
  { key: "joyas", patterns: ["joyas", "piedras preciosas", "metales preciosos"], mark: () => false },
  { key: "prestamistas", patterns: ["prestamistas", "prestamos"], mark: () => false },
  { key: "transportador", patterns: ["sector transportador", "transportador", "transporte de carga"], mark: () => true },
  { key: "dinero_valores", patterns: ["dinero", "valores"], mark: () => false },
  { key: "zonas_francas", patterns: ["zonas francas"], mark: () => false },
  { key: "fondos_remesas", patterns: ["fondos", "remesas"], mark: () => false },
  { key: "cambiarios", patterns: ["cambiarios", "fronterizos"], mark: () => false },
  { key: "moneda_extranjera", patterns: ["moneda extranjera"], mark: () => false },
  { key: "productos_exterior", patterns: ["productos.*exterior", "operaciones.*exterior"], mark: () => false },
  { key: "cuentas_exterior", patterns: ["cuentas.*exterior"], mark: () => false },
  { key: "obligado_declarar_renta", patterns: ["obligado.*declarar.*renta", "declarante.*renta"], mark: () => true },
  { key: "cuenta_corriente", patterns: ["cuenta corriente", "corriente"], mark: () => true },
  { key: "cuenta_ahorros", patterns: ["cuenta ahorros", "ahorros"], mark: () => false },
  { key: "inscripcion", patterns: ["inscripcion"], mark: () => true },
  { key: "actualizacion", patterns: ["actualizacion"], mark: () => false }
];

function fieldHaystack(field: PdfField): string {
  return normalize([field.nombre, field.contextoTexto, field.campoCsv].filter(Boolean).join(" "));
}

export function matchField(name: string, context = ""): { key: string; type: FieldType } | null {
  const haystack = normalize(`${name} ${context}`);
  let best: { key: string; type: FieldType; score: number } | null = null;

  for (const mapping of FIELD_MAPPINGS) {
    for (const pattern of mapping.patterns) {
      if (!matchesPattern(haystack, pattern)) continue;
      const score = normalize(pattern).length;
      if (!best || score > best.score) {
        best = { key: mapping.key, type: mapping.type, score };
      }
    }
  }

  return best ? { key: best.key, type: best.type } : null;
}

function checkboxOption(haystack: string): "si" | "no" | "" {
  if (hasWord(haystack, "si") || hasWord(haystack, "yes")) return "si";
  if (hasWord(haystack, "no")) return "no";
  return "";
}

function resolveCheckbox(field: PdfField, contractorData: ContractorData): { value: string; key: string } | null {
  const haystack = fieldHaystack(field);
  const option = checkboxOption(haystack);

  let best: { concept: CheckboxConcept; score: number } | null = null;
  for (const concept of CHECKBOX_CONCEPTS) {
    for (const pattern of concept.patterns) {
      if (!matchesPattern(haystack, pattern)) continue;
      const score = normalize(pattern).length;
      if (!best || score > best.score) best = { concept, score };
    }
  }

  if (!best) return null;

  const expected = best.concept.mark(contractorData);
  const shouldMark = option === "si" ? expected : option === "no" ? !expected : expected;
  return { value: shouldMark ? "X" : "", key: best.concept.key };
}

export function autocompleteField(field: PdfField, contractorData: ContractorData): PdfField {
  const haystack = fieldHaystack(field);

  if (field.tipo === "firma" || matchesPattern(haystack, "firma")) {
    return {
      ...field,
      tipo: "firma",
      valor: "firma",
      campoCsv: "firma",
      source: field.source === "memoria" ? "memoria" : "auto",
      confianza: Math.max(field.confianza || 0, 0.9)
    };
  }

  if (field.tipo === "huella" || matchesPattern(haystack, "huella")) {
    return {
      ...field,
      tipo: "huella",
      valor: "huella",
      campoCsv: "huella",
      source: field.source === "memoria" ? "memoria" : "auto",
      confianza: Math.max(field.confianza || 0, 0.9)
    };
  }

  if (field.tipo === "checkbox") {
    const resolved = resolveCheckbox(field, contractorData);
    if (!resolved) {
      return {
        ...field,
        valor: field.valor === "X" ? "X" : "",
        confianza: field.valor === "X" ? Math.max(field.confianza, 0.6) : field.confianza
      };
    }

    return {
      ...field,
      valor: resolved.value,
      campoCsv: resolved.key,
      source: field.source === "memoria" ? "memoria" : "auto_checkbox",
      confianza: Math.max(field.confianza || 0, 0.85)
    };
  }

  const match = matchField(field.nombre, field.contextoTexto || "");
  if (!match) {
    return field;
  }

  if (match.type === "firma" || match.type === "huella") {
    return {
      ...field,
      tipo: match.type,
      valor: match.type,
      campoCsv: match.key,
      source: field.source === "memoria" ? "memoria" : "auto",
      confianza: Math.max(field.confianza || 0, 0.9)
    };
  }

  const value = contractorValue(contractorData, match.key);
  if (!value) {
    return {
      ...field,
      campoCsv: match.key,
      confianza: Math.max(0.35, field.confianza || 0)
    };
  }

  return {
    ...field,
    tipo: "texto",
    valor: value,
    campoCsv: match.key,
    source: field.source === "memoria" ? "memoria" : "auto",
    confianza: Math.max(field.confianza || 0, 0.82)
  };
}

export function autocompleteFields(fields: PdfField[], contractorData: ContractorData): PdfField[] {
  return fields.map((field) => autocompleteField(field, contractorData));
}

export function deduplicateFields(fields: PdfField[]): PdfField[] {
  const result: PdfField[] = [];

  for (const field of fields) {
    const existingIndex = result.findIndex((existing) => {
      if (existing.pageNum !== field.pageNum || existing.tipo !== field.tipo) return false;

      const close = Math.abs(existing.x - field.x) <= 10 && Math.abs(existing.y - field.y) <= 10;
      if (close) return true;

      const sameSemanticField =
        Boolean(existing.campoCsv && field.campoCsv && existing.campoCsv === field.campoCsv) ||
        normalize(existing.nombre) === normalize(field.nombre);

      return sameSemanticField && Math.abs(existing.x - field.x) <= 16 && Math.abs(existing.y - field.y) <= 16;
    });

    if (existingIndex === -1) {
      result.push(field);
    } else if ((field.confianza || 0) > (result[existingIndex].confianza || 0)) {
      result[existingIndex] = field;
    }
  }

  return result;
}

function fieldHasFinalValue(field: PdfField): boolean {
  if (field.tipo === "firma" || field.tipo === "huella") return true;
  if (field.tipo === "checkbox") return field.source === "auto_checkbox" || field.valor === "X";
  const value = normalize(field.valor);
  return Boolean(value && value !== "sin dato");
}

export function summarizeAutocomplete(fields: PdfField[]): AutocompleteSummary {
  const total = fields.length;
  const autoCompleted = fields.filter((field) => field.source === "auto" || field.source === "auto_checkbox" || field.source === "memoria").length;
  const completed = fields.filter(fieldHasFinalValue).length;
  const missing = fields.filter((field) => field.tipo === "texto" && !fieldHasFinalValue(field)).length;
  const needsReview = fields.filter((field) => field.confianza < 0.8 || (field.tipo === "texto" && !fieldHasFinalValue(field))).length;
  const checkboxes = fields.filter((field) => field.tipo === "checkbox" && (field.source === "auto_checkbox" || field.valor === "X")).length;
  const images = fields.filter((field) => field.tipo === "firma" || field.tipo === "huella").length;

  return {
    total,
    completed,
    autoCompleted,
    needsReview,
    missing,
    checkboxes,
    images,
    percent: total ? Math.round((completed / total) * 100) : 0
  };
}

export function shouldAutoFill(field: PdfField): boolean {
  return field.confianza >= 0.5 && fieldHasFinalValue(field);
}
