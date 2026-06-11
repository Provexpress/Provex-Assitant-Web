import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

function azureBaseUrl(endpoint: string): string {
  const clean = endpoint.trim().replace(/\/+$/, "");
  return clean.endsWith("/openai/v1") ? `${clean}/` : `${clean}/openai/v1/`;
}

function extractJson(content: string): unknown {
  const cleaned = content.replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("La IA no devolvio JSON");
    return JSON.parse(match[0]);
  }
}

function clientConfig(): { client: OpenAI; model: string; provider: string } {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
  const azureApiKey = process.env.AZURE_OPENAI_API_KEY || "";
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || "";

  if (azureEndpoint || azureApiKey || azureDeployment) {
    if (!azureEndpoint || !azureApiKey || !azureDeployment) {
      throw new Error("Faltan variables de Azure OpenAI en Vercel");
    }
    return {
      client: new OpenAI({ apiKey: azureApiKey, baseURL: azureBaseUrl(azureEndpoint) }),
      model: azureDeployment,
      provider: "Azure OpenAI"
    };
  }

  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY o variables de Azure OpenAI");
  return {
    client: new OpenAI({ apiKey }),
    model: process.env.OPENAI_MODEL || "gpt-4o",
    provider: "OpenAI"
  };
}

const systemPrompt = `Eres Provex Assistant, motor especializado en diligenciar formularios PDF empresariales colombianos de PROVEXPRESS SAS.

Tu ÚNICA salida permitida es un objeto JSON válido. Sin explicaciones, sin saludos, sin markdown.

REGLAS ABSOLUTAS:
1. La imagen fue renderizada a 2x. Divide TODOS los píxeles entre 2 para obtener coordenadas PDF reales.
2. x/y son la esquina SUPERIOR IZQUIERDA del espacio en blanco a rellenar, NO sobre la etiqueta impresa.
3. No rellenes encima de texto ya impreso ni de valores de otra empresa/persona.
4. No dupliques campos: cada campo solo una vez.
5. No inventes valores que no estén en los datos del contratista.

MAPEO DE CAMPOS (etiqueta visible → dato del contratista):
- "TERCERO A EVALUAR", "Razón Social", "Empresa", "En representación de" → razon_social
- "NIT", "N.I.T.", "Identificado con NIT" → nit  
- "Representante Legal", "Yo,", "Nombre completo" → representante_legal
- "C.C.", "Cédula", "Documento de identidad" → documento_identidad
- "Dirección", "Domicilio" → direccion
- "Ciudad" → ciudad
- "Teléfono", "Tel.", "PBX" → telefono
- "Correo", "Email" → correo_contacto
- "Fecha", "Fecha de" → fecha (formato dd/mm/aaaa)
- "Ciudad y Fecha", "Lugar y Fecha" → ciudad_fecha
- "Firma" → tipo=firma, valor=firma
- "Huella" → tipo=huella, valor=huella

FORMATO NIT: XXX.XXX.XXX-X con puntos y guion.
FORMATO FECHA: dd/mm/aaaa (colombiano).

INSTRUCCIONES CRITICAS DE AUTORELLENO:
- TODOS los campos de texto deben traer valor cuando exista en DATOS DEL CONTRATISTA.
- TODOS los checkboxes deben venir decididos: "X" si aplica, "" si no aplica.
- PROVEXPRESS SAS es proveedor/contratista y pertenece al SECTOR TRANSPORTADOR.
- Responsable de IVA: SI. Autorretenedor: SI. Gran contribuyente: NO.
- Es SAS / Sociedad Anonima Simplificada.
- Regimen tributario: ORDINARIO; si el formulario dice "Comun", marcar Comun.
- Tamano empresa: MEDIANA EMPRESA.
- No es PEP. No opera moneda virtual, casinos, armas, joyas, remesas, zonas francas ni bienes raices.
- Para preguntas Si/No, marca la casilla Si o No correcta, no dejes ambas indefinidas.
- Si hay "Ciudad y Fecha" usa ciudad_fecha. Si hay solo "Fecha" usa fecha.
- Devuelve contextoTexto/source_zone cuando puedas, para que la app pueda reforzar el mapeo.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const imageDataUrl = String(body.imageDataUrl || "");
    const contractorData = body.contractorData || {};
    const hints = String(body.memoryHints || "Sin memoria histórica.");
    const pageNumber = Number(body.pageNumber || 1);
    const pageWidth = Number(body.pageWidth || 595);
    const pageHeight = Number(body.pageHeight || 842);

    if (!imageDataUrl.startsWith("data:image/png;base64,")) {
      return NextResponse.json({ error: "Imagen inválida" }, { status: 400 });
    }

    const { client, model, provider } = clientConfig();

    const prompt = `Analiza este formulario PDF y devuelve los campos a rellenar con datos de PROVEXPRESS SAS.

== DATOS DEL CONTRATISTA ==
${JSON.stringify(contractorData, null, 2)}

== INFORMACIÓN DE LA PÁGINA ==
- Número: ${pageNumber}
- Ancho PDF: ${pageWidth} puntos (la imagen es 2x = ${pageWidth * 2}px)
- Alto PDF: ${pageHeight} puntos (la imagen es 2x = ${pageHeight * 2}px)

== MEMORIA HISTÓRICA ==
${hints}

== TAREA ==
1. Identifica campos vacíos: líneas ___, espacios en blanco, checkboxes, zonas de firma/huella.
2. Asigna el valor correcto según el MAPEO DE CAMPOS.
3. ⚠️ DIVIDE todos los píxeles de la imagen entre 2 para obtener coordenadas PDF reales.
4. x/y apuntan al espacio vacío DESPUÉS de la etiqueta, no sobre ella.
5. Para FIRMA: tipo="firma", valor="firma". Para HUELLA: tipo="huella", valor="huella".
6. Para CHECKBOX: valor="X" solo en la opción correcta.
7. NO repitas el mismo campo dos veces.
8. confianza: 0.70 si ves claramente el espacio, 0.45 si es una suposición.
9. No dejes campos vacíos si el dato existe en DATOS DEL CONTRATISTA.
10. Para checkboxes Si/No, devuelve cada checkbox individual con nombre claro: por ejemplo "Gran contribuyente - No".

RESPONDE SOLO CON JSON:
{"campos":[{"nombre":"TERCERO A EVALUAR","valor":"PROVEXPRESS SAS","x":120,"y":95,"tipo":"texto","fontsize":9,"w":160,"h":18,"confianza":0.70,"contextoTexto":"TERCERO A EVALUAR:"}]}`;

    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } }
          ]
        }
      ]
    });

    return NextResponse.json({
      provider,
      model,
      result: extractJson(response.choices[0]?.message?.content || "{}")
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error analizando PDF" },
      { status: 500 }
    );
  }
}
