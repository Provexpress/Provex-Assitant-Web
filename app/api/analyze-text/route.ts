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

const systemPrompt = `Eres Provex Assistant, motor especializado en diligenciar formularios PDF empresariales colombianos de la empresa PROVEXPRESS SAS.

Tu ÚNICA salida permitida es un objeto JSON válido. Sin explicaciones, sin saludos, sin markdown.

REGLAS ABSOLUTAS:
1. NUNCA inventes coordenadas x/y. SIEMPRE usa las coordenadas de las ZONAS VACIAS DETECTADAS cuando existan.
2. Si una zona está detectada, úsala aunque el texto alrededor parezca ambiguo.
3. No rellenes encima de etiquetas impresas ni de valores ya escritos de otra empresa.
4. No dupliques campos: si el mismo nombre ya aparece, omite el duplicado.
5. confianza=0.90 si usas coordenada de zona detectada. confianza=0.55 si añades zona no detectada.

MAPEO DE CAMPOS (aliases → dato del contratista):
- "TERCERO A EVALUAR", "Nombre empresa", "Razón Social", "En representación de" → razon_social
- "NIT", "N.I.T.", "Identificación tributaria", "Identificada con NIT" → nit
- "Representante Legal", "Yo,", "Suscrito", "Nombre completo" → representante_legal
- "C.C.", "Cédula", "Identificado con cédula", "Documento de identidad" → documento_identidad
- "Dirección", "Domicilio", "Sede" → direccion
- "Ciudad" → ciudad
- "Teléfono", "Tel.", "PBX" → telefono
- "Correo", "Email", "E-mail" → correo_contacto
- "Fecha", "Fecha de", "a los días del mes" → fecha
- "Ciudad y Fecha", "Lugar y Fecha" → ciudad_fecha
- "Firma" → tipo firma
- "Huella" → tipo huella

FORMATO DE FECHA: usa siempre dd/mm/aaaa (formato colombiano).
FORMATO NIT: usa XXX.XXX.XXX-X con puntos y guion.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const structuredText = String(body.structuredText || "");
    const contractorData = body.contractorData || {};
    const hints = String(body.memoryHints || "Sin memoria histórica.");
    const emptyZones = Array.isArray(body.emptyZones) ? body.emptyZones : [];

    if (!structuredText.trim()) {
      return NextResponse.json({ error: "Texto estructurado vacío" }, { status: 400 });
    }

    const { client, model, provider } = clientConfig();

    const prompt = `Analiza este formulario PDF y devuelve los campos a rellenar con datos de PROVEXPRESS SAS.

== DATOS DEL CONTRATISTA ==
${JSON.stringify(contractorData, null, 2)}

== ESTRUCTURA EXACTA DE LA PÁGINA ==
${structuredText}

== ZONAS VACÍAS DETECTADAS AUTOMÁTICAMENTE ==
Estas coordenadas son EXACTAS del PDF. Úsalas directamente.
${JSON.stringify(emptyZones, null, 2)}

== MEMORIA HISTÓRICA DE CORRECCIONES ==
${hints}

== TAREA ==
1. Por cada ZONA VACÍA, asigna el valor correcto del contratista usando el MAPEO DE CAMPOS.
2. Si detectas zonas adicionales no listadas (p.ej. patrones "Yo,", "identificado con"), agrégalas con confianza 0.55.
3. Para campos de FECHA: usa el valor "fecha" o "ciudad_fecha" del contratista (formato dd/mm/aaaa).
4. Para FIRMA: tipo="firma", valor="firma". Para HUELLA: tipo="huella", valor="huella".
5. Para CHECKBOX: valor="X" solo en la opción correcta según datos del contratista.
6. NO repitas el mismo campo dos veces.
7. Si una zona no tiene dato correspondiente en el contratista, omítela.

RESPONDE SOLO CON JSON:
{"campos":[{"nombre":"TERCERO A EVALUAR","valor":"PROVEXPRESS SAS","x":217,"y":124,"w":160,"h":18,"tipo":"texto","fontsize":9,"confianza":0.90,"source_zone":"after_label:TERCERO A EVALUAR:"}]}`;

    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ]
    });

    return NextResponse.json({
      provider,
      model,
      mode: "text",
      result: extractJson(response.choices[0]?.message?.content || "{}")
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error analizando PDF" },
      { status: 500 }
    );
  }
}
