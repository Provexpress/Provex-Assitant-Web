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

    if (!imageDataUrl.startsWith("data:image/png;base64,")) {
      return NextResponse.json({ error: "Imagen invalida" }, { status: 400 });
    }

    const { client, model, provider } = clientConfig();
    const prompt = `Analiza esta imagen de un formulario PDF empresarial colombiano.

DATOS DEL CONTRATISTA:
${JSON.stringify(contractorData, null, 2)}

MEMORIA HISTORICA:
${memoryHints}

Identifica campos vacios: lineas, espacios en blanco, checkboxes, firma y huella.

Devuelve SOLO JSON valido:
{"campos":[{"nombre":"TERCERO A EVALUAR","valor":"","x":120,"y":95,"tipo":"texto","fontsize":9,"w":120,"h":22,"confianza":0.6}]}

Reglas:
- Coordenadas en puntos PDF, origen arriba-izquierda.
- La imagen fue renderizada a 2x, divide pixeles entre 2.
- Escribe donde empieza el espacio vacio, no sobre la etiqueta.
- No repitas campos.
- tipo solo puede ser texto, checkbox, firma o huella.
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
