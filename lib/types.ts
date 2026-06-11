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
  source: "ia" | "memoria" | "manual";
  campoCsv?: string;
  iaX?: number;
  iaY?: number;
  suggestedX?: number;
  suggestedY?: number;
  manualSize?: boolean;
  /** Texto impreso cercano al campo (etiqueta), para aprendizaje contextual */
  contextoTexto?: string;
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
};

export type FormularioConocido = {
  fields: PdfField[];
  vecesProcesado: number;
  /** true cuando vecesProcesado >= 3 y sin correcciones recientes → skip IA */
  aprendido?: boolean;
  /** Fecha última vez que se procesó */
  ultimaVez?: string;
};

export type LocalMemory = {
  version: number;
  patronesGlobales: Array<{
    contexto: string;
    offsetX: number;
    offsetY: number;
    vecesAplicado: number;
    vecesCorregido: number;
  }>;
  formulariosConocidos: Record<string, FormularioConocido>;
  historialCorrecciones: HistorialCorreccion[];
};
