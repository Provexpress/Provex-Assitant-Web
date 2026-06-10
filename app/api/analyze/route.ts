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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const imageDataUrl = String(body.imageDataUrl || "");
    const contractorData = body.contractorData || {};
    const memoryHints = String(body.memoryHints || "Sin memoria historica.");
    const pageNumber = Number(body.pageNumber || 1);
    const pageWidth = Number(body.pageWidth || 595);
    const pageHeight = Number(body.pageHeight || 842);

    if (!imageDataUrl.startsWith("data:image/png;base64,")) {
      return NextResponse.json({ error: "Imagen invalida" }, { status: 400 });
    }

    const { client, model, provider } = clientConfig();
    const prompt = `Analiza esta imagen de un formulario PDF empresarial colombiano.

DATOS DEL CONTRATISTA:
${JSON.stringify(contractorData, null, 2)}

MEMORIA HISTORICA:
${memoryHints}

PAGINA:
- Numero: ${pageNumber}
- Ancho PDF: ${pageWidth} puntos
- Alto PDF: ${pageHeight} puntos

Identifica campos vacios: lineas, espacios en blanco, checkboxes, firma y huella. Usa los DATOS DEL CONTRATISTA para proponer el valor correcto.

Devuelve SOLO JSON valido:
{"campos":[{"nombre":"TERCERO A EVALUAR","valor":"PROVEXPRESS SAS","x":120,"y":95,"tipo":"texto","fontsize":9,"w":160,"h":18,"confianza":0.6}]}

Reglas:
- Coordenadas en puntos PDF, origen arriba-izquierda.
- La imagen fue renderizada a 2x, divide pixeles entre 2.
- x/y son la esquina superior izquierda de la caja editable que se vera sobre el PDF.
- Escribe donde empieza el espacio vacio o la linea para llenar, no sobre la etiqueta impresa.
- El texto debe quedar dentro de la linea o espacio disponible. Devuelve w/h aproximados del espacio real para poder encoger texto largo.
- Si el valor es muy largo, aumenta w hasta el final de la linea disponible; no lo dejes encima de otras palabras.
- No agregues campos que ya esten diligenciados con datos claros de otra empresa/persona.
- No repitas campos.
- tipo solo puede ser texto, checkbox, firma o huella.
- Para firma usa tipo firma y valor "firma". Para huella usa tipo huella y valor "huella".
- Para checkbox usa valor "X" solo en la casilla correcta; si no estas seguro deja valor vacio.
- Si no sabes el valor, deja valor vacio.`;

    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 4096,
      messages: [
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
