import type { ContractorData, FieldType, PdfField } from "./types";

function normalize(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const intelligentMap: Array<[string[], string, FieldType]> = [
  [["ciudad y fecha", "lugar y fecha"], "ciudad_fecha", "texto"],
  [["tercero a evaluar", "tercero", "razon social", "empresa", "nombre empresa", "denominacion social"], "razon_social", "texto"],
  [["nit", "n.i.t", "identificacion", "numero identificacion"], "nit", "texto"],
  [["representante legal", "rep legal", "representante", "nombre de quien diligencia", "yo,"], "representante_legal", "texto"],
  [["cedula", "c.c", "cc", "documento", "documento identidad"], "documento_identidad", "texto"],
  [["direccion", "domicilio"], "direccion", "texto"],
  [["ciudad", "municipio"], "ciudad", "texto"],
  [["departamento"], "departamento", "texto"],
  [["pais"], "pais", "texto"],
  [["telefono", "tel"], "telefono", "texto"],
  [["celular", "movil"], "celular", "texto"],
  [["correo", "email", "e-mail"], "correo_contacto", "texto"],
  [["actividad economica", "ciiu"], "actividad_economica", "texto"],
  [["regimen", "regimen tributario"], "regimen_tributario", "texto"],
  [["responsable iva"], "responsable_iva", "texto"],
  [["gran contribuyente"], "gran_contribuyente", "texto"],
  [["autorretenedor"], "autorretenedor_renta", "texto"],
  [["tamano empresa", "tipo empresa"], "tamano_empresa", "texto"],
  [["fecha", "fecha registro", "fecha diligenciamiento"], "fecha", "texto"],
  [["firma"], "firma", "firma"],
  [["huella"], "huella", "huella"]
];

export function matchField(name: string): { key: string; type: FieldType } | null {
  const normalized = normalize(name);
  let best: { key: string; type: FieldType; score: number } | null = null;

  for (const [patterns, key, type] of intelligentMap) {
    for (const pattern of patterns) {
      const needle = normalize(pattern);
      if (needle && normalized.includes(needle) && (!best || needle.length > best.score)) {
        best = { key, type, score: needle.length };
      }
    }
  }

  return best ? { key: best.key, type: best.type } : null;
}

export function autocompleteField(field: PdfField, contractorData: ContractorData): PdfField {
  const match = matchField(field.nombre);
  if (!match) {
    return field.valor ? field : { ...field, valor: "[SIN DATO]" };
  }

  if (match.type === "firma" || match.type === "huella") {
    return { ...field, tipo: match.type, valor: match.type, campoCsv: match.key };
  }

  if (field.tipo === "checkbox") {
    const value = normalize(contractorData[match.key]);
    const name = normalize(field.nombre);
    const checked = value === "si" || value === "x" || (name.includes("no") && value === "no");
    return { ...field, valor: checked ? "X" : field.valor || "", campoCsv: match.key };
  }

  return {
    ...field,
    tipo: "texto",
    valor: contractorData[match.key] || "[SIN DATO]",
    campoCsv: match.key
  };
}

export function autocompleteFields(fields: PdfField[], contractorData: ContractorData): PdfField[] {
  return fields.map((field) => autocompleteField(field, contractorData));
}
