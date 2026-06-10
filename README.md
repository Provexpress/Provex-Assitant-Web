# Provex Assistant Web

Version web nativa del rellenador de PDFs de Provexpress.

## Enfoque

- Next.js + React para desplegar en Vercel.
- Login con Microsoft Entra ID usando MSAL.
- Editor visual sobre PDF con PDF.js.
- Generacion final con `pdf-lib`.
- IA via API route server-side, sin exponer claves al navegador.
- Memoria local en el navegador, sin `memoria.json` de servidor y sin base de datos.

La memoria se guarda en `localStorage` del usuario. Esto es rapido para salir a produccion sin base de datos, pero no se comparte automaticamente entre computadores.

## Desarrollo local

```bash
npm install
npm run dev
```

Crea `.env.local` desde `.env.example`.

## Variables para Vercel

Publicas:

```env
NEXT_PUBLIC_MS_TENANT_ID=e6805558-f5bb-444c-8af2-5f3a4d6dd3fc
NEXT_PUBLIC_MS_CLIENT_ID=ffcf61c2-18a2-4be4-a753-c81934026e4d
```

Secretas:

```env
AZURE_OPENAI_ENDPOINT=https://provex-foundry-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-4.1-mini
```

## Microsoft Redirect URI

Cuando Vercel entregue la URL de produccion, agregala en Microsoft Entra ID:

1. Azure Portal -> Microsoft Entra ID.
2. App registrations -> la app con client id `ffcf61c2-18a2-4be4-a753-c81934026e4d`.
3. Authentication -> Platform configurations.
4. Agrega una Redirect URI de tipo `Single-page application`.
5. Usa exactamente la URL de Vercel, por ejemplo:

```text
https://provex-assitant-web.vercel.app
```

La app usa `window.location.origin` como redirect URI, por eso debe coincidir con el dominio real desplegado.

## Flujo

1. Login Microsoft.
2. Subir PDF.
3. Analizar con IA o agregar campos rapidos.
4. Arrastrar campos sobre el PDF.
5. Generar y descargar PDF.

## Nota sobre memoria

No hay base de datos. La memoria vive en el navegador:

- Pros: cero configuracion, sirve en Vercel inmediatamente.
- Contras: cada usuario tiene su propia memoria local.

Si luego quieren memoria compartida, se puede migrar a Vercel KV o Supabase sin cambiar el editor.
