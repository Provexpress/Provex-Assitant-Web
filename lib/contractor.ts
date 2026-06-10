import type { ContractorData, FieldOption } from "./types";

function today(): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date());
}

const baseContractorData: ContractorData = {
  razon_social: "PROVEXPRESS SAS",
  nit: "900800595-8",
  representante_legal: "RAFAEL FRANCISCO NOVOA PALLADINO",
  cc: "CE 227.282",
  documento_identidad: "CE 227.282",
  direccion: "Aut. Medellin Km 3.5",
  ciudad: "COTA",
  departamento: "CUNDINAMARCA",
  pais: "COLOMBIA",
  telefono: "5185099",
  celular: "",
  correo: "c.estrategica@provexpress.com.co",
  correo_contacto: "c.estrategica@provexpress.com.co",
  actividad_economica: "4651",
  regimen_tributario: "ORDINARIO",
  responsable_iva: "SI",
  gran_contribuyente: "NO",
  autorretenedor_renta: "SI",
  tamano_empresa: "MEDIANA EMPRESA",
  checkbox_si: "X",
  checkbox_no: "X"
};

export function getContractorData(): ContractorData {
  const fecha = today();
  const ciudad = baseContractorData.ciudad || "COTA";
  return {
    ...baseContractorData,
    fecha,
    fecha_hoy: fecha,
    ciudad_fecha: `${ciudad}, ${fecha}`,
    ciudad_y_fecha: `${ciudad}, ${fecha}`,
    nombre: baseContractorData.representante_legal,
    empresa: baseContractorData.razon_social,
    email: baseContractorData.correo_contacto
  };
}

export function getFieldOptions(): FieldOption[] {
  const data = getContractorData();
  return [
    ["razon_social", "Razon Social", "texto"],
    ["nit", "NIT", "texto"],
    ["representante_legal", "Representante Legal", "texto"],
    ["documento_identidad", "C.C. / Documento", "texto"],
    ["direccion", "Direccion", "texto"],
    ["ciudad", "Ciudad", "texto"],
    ["departamento", "Departamento", "texto"],
    ["pais", "Pais", "texto"],
    ["telefono", "Telefono", "texto"],
    ["celular", "Celular", "texto"],
    ["correo_contacto", "Correo", "texto"],
    ["actividad_economica", "Actividad Economica", "texto"],
    ["regimen_tributario", "Regimen Tributario", "texto"],
    ["responsable_iva", "Responsable IVA", "texto"],
    ["gran_contribuyente", "Gran Contribuyente", "texto"],
    ["autorretenedor_renta", "Autorretenedor Renta", "texto"],
    ["tamano_empresa", "Tamano Empresa", "texto"],
    ["fecha", "Fecha", "texto"],
    ["ciudad_fecha", "Ciudad y Fecha", "texto"],
    ["checkbox_si", "Checkbox SI", "checkbox"],
    ["checkbox_no", "Checkbox NO", "checkbox"],
    ["firma", "Firma", "firma"],
    ["huella", "Huella", "huella"]
  ].map(([key, label, type]) => ({
    key,
    label,
    type: type as FieldOption["type"],
    value: key === "firma" ? "firma" : key === "huella" ? "huella" : data[key] || ""
  }));
}
