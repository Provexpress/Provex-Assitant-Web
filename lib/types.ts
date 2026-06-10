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
};

export type FieldOption = {
  key: string;
  label: string;
  type: FieldType;
  value: string;
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
  formulariosConocidos: Record<string, { fields: PdfField[]; vecesProcesado: number }>;
  historialCorrecciones: Array<{
    fecha: string;
    pdf: string;
    campo: string;
    dx: number;
    dy: number;
  }>;
};
