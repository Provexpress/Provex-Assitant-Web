export type FieldType = "texto" | "checkbox" | "firma" | "huella";

export type ContractorData = Record<string, string>;

export type PdfField = {
  id: string;
  pageNum: number;
  nombre: string;
  valor: string;
  tipo: FieldType;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  confianza: number;
  source: "ia" | "memoria" | "manual" | "auto" | "auto_checkbox";
  campoCsv?: string;
  iaX?: number;
  iaY?: number;
  suggestedX?: number;
  suggestedY?: number;
  manualSize?: boolean;
  /** Texto impreso cercano al campo (etiqueta), para aprendizaje contextual */
  contextoTexto?: string;
  /** Última vez que fue confirmado por el usuario */
  lastConfirmed?: string;
};

export type FieldOption = {
  key: string;
  label: string;
  type: FieldType;
  value: string;
};

export type HistorialCorreccion = {
  fecha: string;
  pdf: string;
  campo: string;
  dx: number;
  dy: number;
  /** Etiqueta impresa cercana al campo corregido */
  etiqueta?: string;
  /** Contexto: tipo + nombre normalizado */
  contexto?: string;
  /** Clave del formulario donde ocurrió la corrección (para scope) */
  formKey?: string;
};

/** Patrón de offset aprendido para un tipo/nombre de campo */
export type PatronGlobal = {
  contexto: string;
  offsetX: number;
  offsetY: number;
  vecesAplicado: number;
  vecesCorregido: number;
  /** Fecha de la última vez que fue corregido (para decaimiento) */
  ultimaVez?: string;
  /** Formulario al que pertenece preferentemente (scope) */
  formKey?: string;
};

export type FormularioConocido = {
  fields: PdfField[];
  vecesProcesado: number;
  /** true cuando vecesProcesado >= 3 → skip IA */
  aprendido?: boolean;
  /** Fecha última vez que se procesó */
  ultimaVez?: string;
  /**
   * Fingerprint de estructura del PDF (palabras clave del contenido).
   * Permite reconocer el mismo formulario aunque el nombre del archivo cambie.
   */
  structureHash?: string;
  /** Versión del esquema de memoria, para migraciones futuras */
  formVersion?: number;
};

export type LocalMemory = {
  version: number;
  patronesGlobales: PatronGlobal[];
  formulariosConocidos: Record<string, FormularioConocido>;
  historialCorrecciones: HistorialCorreccion[];
  /**
   * Índice de fingerprints → formKey.
   * Permite encontrar un formulario por contenido aunque cambie el nombre del archivo.
   */
  fingerprintIndex?: Record<string, string>;
};
