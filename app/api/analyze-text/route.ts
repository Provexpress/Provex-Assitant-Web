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
    const structuredText = String(body.structuredText || "");
    const contractorData = body.contractorData || {};
    const memoryHints = String(body.memoryHints || "Sin memoria historica.");
    const emptyZones = Array.isArray(body.emptyZones) ? body.emptyZones : [];

    if (!structuredText.trim()) {
      return NextResponse.json({ error: "Texto estructurado vacio" }, { status: 400 });
    }

    const { client, model, provider } = clientConfig();
    const prompt = `Eres un asistente que rellena formularios PDF empresariales colombianos.

DATOS DEL CONTRATISTA:
${JSON.stringify(contractorData, null, 2)}

ESTRUCTURA DE LA PAGINA DEL PDF:
${structuredText}

ZONAS VACIAS YA DETECTADAS:
${JSON.stringify(emptyZones, null, 2)}

MEMORIA DE CORRECCIONES ANTERIORES:
${memoryHints}

TAREA:
1. Para cada zona vacia detectada, asigna el valor correcto de los datos del contratista.
2. Si detectas campos vacios adicionales que no estan en la lista, agregalos.
3. Usa coordenadas de la estructura del PDF. No inventes coordenadas si ya hay una zona compatible.
4. Para checkboxes, marca con "X" solo la opcion correcta.
5. Para firma y huella, usa tipo "firma" o "huella".

Devuelve SOLO JSON valido:
{"campos":[{"nombre":"TERCERO A EVALUAR","valor":"PROVEXPRESS SAS","x":217,"y":124,"w":160,"h":22,"tipo":"texto","fontsize":9,"confianza":0.85,"source_zone":"after_label:TERCERO A EVALUAR:"}]}

REGLAS:
- Usa las coordenadas x, y de las zonas detectadas cuando correspondan. Son la esquina superior izquierda del campo editable.
- Si una zona no tiene dato correspondiente, omitela.
- tipo solo puede ser texto, checkbox, firma o huella.
- confianza: 0.85 si usas una zona detectada, 0.6 si agregas una zona no detectada.
- Si no sabes que dato va, deja valor vacio.
- No rellenes datos que claramente pertenezcan a otra empresa o persona ya escrita en el PDF.`;

    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
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
