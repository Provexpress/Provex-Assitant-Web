"use client";

import { PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { useEffect, useMemo, useRef, useState } from "react";
import { autocompleteFields } from "../lib/autocomplete";
import { getContractorData, getFieldOptions } from "../lib/contractor";
import { applyMemoryOffsets, detectCode, learnFromConfirmation, loadMemory, resetMemory } from "../lib/memory";
import { extractPageStructure, type PageStructure } from "../lib/pdfTextExtract";
import type { FieldOption, FieldType, LocalMemory, PdfField } from "../lib/types";

declare global {
  interface Window {
    pdfjsLib?: {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument: (source: { data: Uint8Array }) => { promise: Promise<PdfJsDocument> };
    };
  }
}

type PdfJsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
};

type PdfJsPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
  render: (options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
    transform?: number[] | null;
  }) => { promise: Promise<void> };
};

type DragState = {
  id: string;
  startX: number;
  startY: number;
  startFieldX: number;
  startFieldY: number;
};

type ResizeState = {
  id: string;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
};

type TransparentImages = {
  firma: string;
  huella: string;
};

const pdfJsUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const pdfWorkerUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(script);
  });
}

async function loadPdfJs() {
  await loadScript(pdfJsUrl);
  if (!window.pdfjsLib) throw new Error("PDF.js no esta disponible");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return window.pdfjsLib;
}

function newFieldId(prefix = "field") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function defaultSize(type: FieldType) {
  if (type === "firma") return { w: 120, h: 44 };
  if (type === "huella") return { w: 70, h: 92 };
  return { w: 150, h: 24 };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

async function makeWhiteTransparent(src: string): Promise<string> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    image.src = src;
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return src;

  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < data.data.length; index += 4) {
    const red = data.data[index];
    const green = data.data[index + 1];
    const blue = data.data[index + 2];
    const alpha = data.data[index + 3];
    if (alpha > 0 && red >= 242 && green >= 242 && blue >= 242) {
      data.data[index + 3] = 0;
    }
  }
  context.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable;
}

function normalizeAiField(raw: Record<string, unknown>, pageNum: number, index: number): PdfField {
  const tipo = String(raw.tipo || "texto").toLowerCase() as FieldType;
  const safeType: FieldType = ["texto", "checkbox", "firma", "huella"].includes(tipo) ? tipo : "texto";
  const size = defaultSize(safeType);
  const x = Number(raw.x || 0);
  const y = Number(raw.y || 0);
  return {
    id: newFieldId(`ia_${pageNum}_${index}`),
    pageNum,
    nombre: String(raw.nombre || raw.campo || "Campo"),
    valor: String(raw.valor || ""),
    tipo: safeType,
    x,
    y,
    w: Number(raw.w || raw.width || size.w),
    h: Number(raw.h || raw.height || size.h),
    fontSize: Number(raw.fontsize || raw.fontSize || 9),
    confianza: Number(raw.confianza || 0.55),
    source: "ia",
    iaX: x,
    iaY: y,
    suggestedX: x,
    suggestedY: y
  };
}

function memoryHints(memory: LocalMemory) {
  return memory.patronesGlobales
    .slice(0, 6)
    .map((pattern) => `- ${pattern.contexto}: mover X ${pattern.offsetX.toFixed(1)}, Y ${pattern.offsetY.toFixed(1)}`)
    .join("\n");
}

function fitFontSize(font: { widthOfTextAtSize: (text: string, size: number) => number }, text: string, maxSize: number, maxWidth: number) {
  const safeText = text.replace(/\s+/g, " ").trim();
  if (!safeText || maxWidth <= 4) return maxSize;

  let size = clamp(maxSize, 5, 18);
  while (size > 5 && font.widthOfTextAtSize(safeText, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

async function extractPdfText(pdfDocument: PdfJsDocument, maxPages = 3) {
  const chunks: string[] = [];
  const pagesToRead = Math.min(pdfDocument.numPages, maxPages);

  for (let index = 0; index < pagesToRead; index += 1) {
    const page = await pdfDocument.getPage(index + 1);
    const content = await page.getTextContent();
    chunks.push(content.items.map((item) => item.str || "").join(" "));
  }

  return chunks.join("\n").replace(/\s+/g, " ").trim().slice(0, 5000);
}

export default function Home() {
  const contractorData = useMemo(() => getContractorData(), []);
  const fieldOptions = useMemo(() => getFieldOptions(), []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const copiedFieldRef = useRef<PdfField | null>(null);
  const msalRef = useRef<PublicClientApplication | null>(null);

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [authStatus, setAuthStatus] = useState("Esperando conexion");
  const [memory, setMemory] = useState<LocalMemory | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfJsDocument | null>(null);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState("");
  const [currentMemoryKey, setCurrentMemoryKey] = useState("");
  const [pageNum, setPageNum] = useState(0);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [zoom, setZoom] = useState(1.35);
  const [fields, setFields] = useState<PdfField[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedQuick, setSelectedQuick] = useState<FieldOption | null>(null);
  const [status, setStatus] = useState("Sube un PDF para empezar.");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [editingId, setEditingId] = useState("");
  const [copiedLabel, setCopiedLabel] = useState("");
  const [transparentImages, setTransparentImages] = useState<TransparentImages>({
    firma: "/firmas/firma.png",
    huella: "/firmas/huella.png"
  });

  const selectedField = fields.find((field) => field.id === selectedId);
  const pageFields = fields.filter((field) => field.pageNum === pageNum);

  useEffect(() => {
    setMemory(loadMemory());
  }, []);

  useEffect(() => {
    Promise.all([makeWhiteTransparent("/firmas/firma.png"), makeWhiteTransparent("/firmas/huella.png")])
      .then(([firma, huella]) => setTransparentImages({ firma, huella }))
      .catch(() => setStatus("No se pudieron preparar firma/huella transparentes; se usaran las imagenes originales."));
  }, []);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;
    const currentPdfDoc = pdfDoc;

    async function renderPage() {
      const page = await currentPdfDoc.getPage(pageNum + 1);
      const viewport = page.getViewport({ scale: zoom });
      const viewportBase = page.getViewport({ scale: 1 });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setPageSize({ width: viewportBase.width, height: viewportBase.height });
      await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
      }).promise;
    }

    renderPage().catch((error) => setStatus(error instanceof Error ? error.message : "No se pudo renderizar"));
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageNum, zoom]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if (!selectedField) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
          event.preventDefault();
          pasteCopiedField();
        }
        return;
      }

      const step = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        nudgeSelected(-step, 0);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        nudgeSelected(step, 0);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        nudgeSelected(0, -step);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        nudgeSelected(0, step);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeField(selectedField.id);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelectedField();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteCopiedField();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateField(selectedField);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (selectedField.tipo === "texto" || selectedField.tipo === "checkbox") {
          setEditingId(selectedField.id);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedField, pageNum, pageSize.width, pageSize.height]);

  async function loginMicrosoft() {
    const tenantId = process.env.NEXT_PUBLIC_MS_TENANT_ID || "";
    const clientId = process.env.NEXT_PUBLIC_MS_CLIENT_ID || "";

    if (!tenantId || !clientId) {
      setAuthStatus("Falta configurar NEXT_PUBLIC_MS_TENANT_ID y NEXT_PUBLIC_MS_CLIENT_ID");
      return;
    }

    const app =
      msalRef.current ||
      new PublicClientApplication({
        auth: {
          clientId,
          authority: `https://login.microsoftonline.com/${tenantId}`,
          redirectUri: window.location.origin
        },
        cache: { cacheLocation: "localStorage" }
      });

    msalRef.current = app;
    await app.initialize();
    setAuthStatus("Conectando con Microsoft...");
    const result = await app.loginPopup({ scopes: ["User.Read"] });
    setAccount(result.account);
    setAuthStatus(result.account?.username || "Sesion iniciada");
  }

  async function openPdf(file: File) {
    setStatus("Cargando PDF...");
    setDownloadUrl("");
    const bytes = await file.arrayBuffer();
    const pdfjs = await loadPdfJs();
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
    const activeMemory = memory || loadMemory();
    if (!memory) setMemory(activeMemory);
    const pdfText = await extractPdfText(document);
    const contentCode = detectCode(`${file.name}\n${pdfText}`);
    const fileCode = detectCode(file.name);
    const knownKey = activeMemory.formulariosConocidos[contentCode] ? contentCode : activeMemory.formulariosConocidos[fileCode] ? fileCode : "";

    setPdfBytes(bytes);
    setPdfDoc(document);
    setFileName(file.name);
    setCurrentMemoryKey(contentCode || fileCode);
    setPageNum(0);
    setFields([]);
    setSelectedId("");

    const known = knownKey ? activeMemory.formulariosConocidos[knownKey] : undefined;
    if (known?.fields?.length) {
      const remembered = autocompleteFields(
        known.fields.map((field) => ({
          ...field,
          id: newFieldId("mem"),
          source: "memoria",
          confianza: Math.max(field.confianza, 0.93),
          iaX: field.x,
          iaY: field.y,
          suggestedX: field.x,
          suggestedY: field.y
        })),
        contractorData
      );
      setFields(remembered);
      setStatus(`Usando memoria exacta para ${knownKey}. No se aplicaron promedios ni offsets.`);
    } else {
      setStatus("PDF cargado. Analizando automaticamente con IA...");
      try {
        await analyzeDocument(document, activeMemory);
      } catch (error) {
        setStatus(error instanceof Error ? `La IA no pudo analizar: ${error.message}` : "La IA no pudo analizar el PDF. Puedes agregar campos manualmente.");
      }
    }
  }

  function addField(option: FieldOption, x = pageSize.width / 2 - 70, y = pageSize.height / 2) {
    const size = defaultSize(option.type);
    const field: PdfField = {
      id: newFieldId("manual"),
      pageNum,
      nombre: option.label,
      valor: option.type === "checkbox" ? "X" : option.value,
      tipo: option.type,
      x: clamp(x, 0, pageSize.width),
      y: clamp(y, 0, pageSize.height),
      w: size.w,
      h: size.h,
      fontSize: 9,
      confianza: 0.5,
      source: "manual",
      campoCsv: option.key,
      iaX: x,
      iaY: y,
      suggestedX: x,
      suggestedY: y
    };
    setFields((current) => [...current, field]);
    setSelectedId(field.id);
    setSelectedQuick(option);
    setDownloadUrl("");
    return field.id;
  }

  function addFieldFromDoubleClick(x: number, y: number) {
    const option =
      selectedQuick ||
      ({
        key: "texto_libre",
        label: "Texto libre",
        type: "texto",
        value: ""
      } satisfies FieldOption);
    const id = addField(option, x, y);
    if (option.type === "texto" || option.type === "checkbox") {
      setEditingId(id);
    }
  }

  function updateField(id: string, patch: Partial<PdfField>) {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
    setDownloadUrl("");
  }

  function removeField(id: string) {
    setFields((current) => current.filter((field) => field.id !== id));
    setSelectedId("");
    setEditingId("");
    setDownloadUrl("");
  }

  function duplicateField(field: PdfField, dx = 14, dy = 14) {
    const copy: PdfField = {
      ...field,
      id: newFieldId("copy"),
      x: clamp(field.x + dx, 0, pageSize.width),
      y: clamp(field.y + dy, 0, pageSize.height),
      source: "manual",
      confianza: Math.min(field.confianza, 0.6),
      iaX: field.x + dx,
      iaY: field.y + dy,
      suggestedX: field.x + dx,
      suggestedY: field.y + dy
    };
    setFields((current) => [...current, copy]);
    setSelectedId(copy.id);
    setEditingId("");
    setDownloadUrl("");
    setStatus(`Copiado: ${copy.nombre}`);
  }

  function copySelectedField() {
    if (!selectedField) return;
    copiedFieldRef.current = selectedField;
    setCopiedLabel(selectedField.nombre);
    setStatus(`Campo copiado: ${selectedField.nombre}`);
  }

  function pasteCopiedField() {
    const copied = copiedFieldRef.current;
    if (!copied) {
      setStatus("No hay campo copiado.");
      return;
    }
    duplicateField({ ...copied, pageNum }, 18, 18);
  }

  function nudgeSelected(dx: number, dy: number) {
    if (!selectedField) return;
    updateField(selectedField.id, {
      x: clamp(selectedField.x + dx, 0, pageSize.width),
      y: clamp(selectedField.y + dy, 0, pageSize.height)
    });
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>, field: PdfField) {
    event.preventDefault();
    event.stopPropagation();
    setEditingId("");
    setSelectedId(field.id);
    dragRef.current = {
      id: field.id,
      startX: event.clientX,
      startY: event.clientY,
      startFieldX: field.x,
      startFieldY: field.y
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", stopDrag, { once: true });
  }

  function startResize(event: React.PointerEvent<HTMLButtonElement>, field: PdfField) {
    event.preventDefault();
    event.stopPropagation();
    setEditingId("");
    setSelectedId(field.id);
    resizeRef.current = {
      id: field.id,
      startX: event.clientX,
      startY: event.clientY,
      startW: field.w,
      startH: field.h
    };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", stopResize, { once: true });
  }

  function onDragMove(event: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / zoom;
    const dy = (event.clientY - drag.startY) / zoom;
    updateField(drag.id, {
      x: clamp(drag.startFieldX + dx, 0, pageSize.width),
      y: clamp(drag.startFieldY + dy, 0, pageSize.height)
    });
  }

  function onResizeMove(event: PointerEvent) {
    const resize = resizeRef.current;
    if (!resize) return;
    const dx = (event.clientX - resize.startX) / zoom;
    const dy = (event.clientY - resize.startY) / zoom;
    const nextH = clamp(resize.startH + dy, 12, pageSize.height);
    const resizingField = fields.find((field) => field.id === resize.id);
    const patch: Partial<PdfField> = {
      w: clamp(resize.startW + dx, 20, pageSize.width),
      h: nextH
    };
    if (resizingField?.tipo === "texto" || resizingField?.tipo === "checkbox") {
      patch.fontSize = clamp(Math.round(nextH * 0.48), 6, 18);
    }
    updateField(resize.id, patch);
  }

  function stopDrag() {
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
  }

  function stopResize() {
    resizeRef.current = null;
    window.removeEventListener("pointermove", onResizeMove);
  }

  async function analyzeDocument(pdfDocument: PdfJsDocument, memoryOverride: LocalMemory | null = memory) {
    setStatus("Extrayendo estructura del PDF...");
    const detected: PdfField[] = [];
    const activeMemory = memoryOverride || memory;

    for (let index = 0; index < pdfDocument.numPages; index += 1) {
      setStatus(`Analizando pagina ${index + 1}/${pdfDocument.numPages}...`);
      const pageStruct: PageStructure = await extractPageStructure(pdfDocument, index);
      let campos: Array<Record<string, unknown>> = [];

      if (pageStruct.hasEnoughText) {
        setStatus(`Pagina ${index + 1}: usando analisis por texto (${pageStruct.emptyZones.length} zonas detectadas)...`);

        const response = await fetch("/api/analyze-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            structuredText: pageStruct.structuredText,
            contractorData,
            memoryHints: activeMemory ? memoryHints(activeMemory) : "",
            emptyZones: pageStruct.emptyZones
          })
        });

        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Analisis de texto fallo");
        campos = Array.isArray(payload.result?.campos) ? payload.result.campos : [];
      } else {
        setStatus(`Pagina ${index + 1}: PDF sin texto suficiente, usando Vision...`);

        const page = await pdfDocument.getPage(index + 1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d");
        if (!context) continue;
        await page.render({ canvasContext: context, viewport }).promise;

        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageDataUrl: canvas.toDataURL("image/png"),
            contractorData,
            memoryHints: activeMemory ? memoryHints(activeMemory) : "",
            pageNumber: index + 1,
            pageWidth: pageStruct.width,
            pageHeight: pageStruct.height
          })
        });

        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Vision fallo");
        campos = Array.isArray(payload.result?.campos) ? payload.result.campos : [];
      }

      detected.push(...campos.map((field: Record<string, unknown>, fieldIndex: number) => normalizeAiField(field, index, fieldIndex)));
    }

    const completedFields = autocompleteFields(detected, contractorData);
    setFields(activeMemory ? applyMemoryOffsets(activeMemory, completedFields) : completedFields);
    setStatus(`IA detecto ${detected.length} campos. Ajustalos sobre el PDF.`);
  }

  async function analyzeWithAi() {
    if (!pdfDoc) return;
    try {
      await analyzeDocument(pdfDoc);
    } catch (error) {
      setStatus(error instanceof Error ? `La IA no pudo analizar: ${error.message}` : "La IA no pudo analizar el PDF.");
    }
  }

  async function generatePdf() {
    if (!pdfBytes) return;
    setStatus("Generando PDF...");
    const document = await PDFDocument.load(pdfBytes.slice(0));
    const font = await document.embedFont(StandardFonts.Helvetica);
    const signatureBytes = await fetch(transparentImages.firma).then((res) => res.arrayBuffer());
    const fingerprintBytes = await fetch(transparentImages.huella).then((res) => res.arrayBuffer());
    const signature = await document.embedPng(signatureBytes);
    const fingerprint = await document.embedPng(fingerprintBytes);

    for (const field of fields) {
      const page = document.getPages()[field.pageNum];
      if (!page) continue;
      const { height } = page.getSize();
      const y = height - field.y - (field.tipo === "texto" || field.tipo === "checkbox" ? field.fontSize : field.h);

      if (field.tipo === "texto" && field.valor) {
        const fittedSize = fitFontSize(font, field.valor, field.fontSize, Math.max(12, field.w - 4));
        page.drawText(field.valor, {
          x: field.x,
          y,
          size: fittedSize,
          font,
          color: rgb(0, 0, 0),
          maxWidth: field.w
        });
      } else if (field.tipo === "checkbox" && field.valor) {
        const fittedSize = fitFontSize(font, "X", field.fontSize, Math.max(10, field.w));
        page.drawText("X", { x: field.x, y, size: fittedSize, font, color: rgb(0, 0, 0) });
      } else if (field.tipo === "firma") {
        page.drawImage(signature, { x: field.x, y, width: field.w, height: field.h });
      } else if (field.tipo === "huella") {
        page.drawImage(fingerprint, { x: field.x, y, width: field.w, height: field.h });
      }
    }

    const bytes = await document.save();
    const pdfBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(pdfBuffer).set(bytes);
    const blob = new Blob([pdfBuffer], { type: "application/pdf" });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(URL.createObjectURL(blob));
    if (memory) {
      const learned = learnFromConfirmation(memory, currentMemoryKey || fileName, fields, [fileName]);
      setMemory(learned);
      setFields((current) =>
        current.map((field) => ({
          ...field,
          source: "memoria",
          confianza: Math.min(0.99, Math.max(0.92, field.confianza + 0.08)),
          iaX: field.x,
          iaY: field.y,
          suggestedX: field.x,
          suggestedY: field.y
        }))
      );
    }
    setStatus("PDF generado. La memoria local guardo estas posiciones exactas.");
  }

  if (!account) {
    return (
      <main className="px-auth-gate">
        <section className="px-auth-card">
          <div className="px-auth-brand">
            <div>
              <div className="px-logo px-logo--brand px-logo--wide">
                <img alt="Provexpress" src="/brand/provex-logo.jpeg" />
              </div>
              <p className="px-eyebrow px-mt-4">Provex Assistant Web</p>
              <h1 className="px-title px-title--hero">Editor de PDFs con IA</h1>
              <p className="px-copy">Rellena formularios, revisa en el PDF y descarga el archivo listo.</p>
            </div>
            <div className="px-feature-list">
              <div className="px-feature"><span className="px-dot" /> Login Microsoft 365</div>
              <div className="px-feature"><span className="px-dot px-dot--purple" /> Memoria local sin base de datos</div>
              <div className="px-feature"><span className="px-dot" /> Despliegue directo en Vercel</div>
            </div>
          </div>
          <div className="px-auth-action">
            <div className="px-logo px-logo--sm px-logo--brand">
              <img alt="Provexpress" src="/brand/provex-icon.png" />
            </div>
            <h2 className="px-title px-mt-4">Continuar con Microsoft</h2>
            <p className="px-copy">Usa tu cuenta corporativa para entrar al editor.</p>
            <button className="px-btn px-btn--primary px-mt-4" type="button" onClick={loginMicrosoft}>
              Continuar con Microsoft 365
            </button>
            <p className="px-help px-mt-4">{authStatus}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-frame">
      <header className="px-topbar">
        <div className="px-brand">
          <div className="px-logo px-logo--sm px-logo--brand">
            <img alt="Provexpress" src="/brand/provex-icon.png" />
          </div>
          <div className="px-brand__meta">
            <h1 className="px-brand__title">Provex Assistant Web</h1>
            <p className="px-brand__subtitle">{account.username}</p>
          </div>
        </div>
        <div className="px-actions">
          <label className="px-btn px-btn--secondary">
            Subir PDF
            <input hidden type="file" accept="application/pdf" onChange={(event) => event.target.files?.[0] && openPdf(event.target.files[0])} />
          </label>
          <button className="px-btn px-btn--ghost" type="button" onClick={() => setZoom((value) => Math.max(0.7, value - 0.1))}>
            Zoom -
          </button>
          <button className="px-btn px-btn--ghost" type="button" onClick={() => setZoom((value) => Math.min(3, value + 0.1))}>
            Zoom +
          </button>
          <button className="px-btn px-btn--ghost" type="button" disabled={!selectedField} onClick={copySelectedField}>
            Copiar
          </button>
          <button className="px-btn px-btn--ghost" type="button" disabled={!copiedLabel} onClick={pasteCopiedField}>
            Pegar
          </button>
          <button className="px-btn px-btn--ghost" type="button" disabled={!selectedField} onClick={() => selectedField && duplicateField(selectedField)}>
            Duplicar
          </button>
          <button className="px-btn px-btn--primary" type="button" disabled={!pdfDoc} onClick={analyzeWithAi}>
            Analizar con IA
          </button>
          <button className="px-btn px-btn--accent" type="button" disabled={!pdfBytes || !fields.length} onClick={generatePdf}>
            Generar PDF
          </button>
          {downloadUrl && (
            <a className="px-btn px-btn--primary" href={downloadUrl} download={`RELLENADO_${fileName || "formulario.pdf"}`}>
              Descargar
            </a>
          )}
        </div>
      </header>

      <p className="px-alert px-mt-4">{status}</p>

      <section className="studio-shell px-mt-4">
        <div className="pdf-stage">
          {!pdfDoc && (
            <div className="drop-zone">
              <div>
                <h2 className="px-panel__title">Sube un PDF</h2>
                <p className="px-copy">Luego usa IA o agrega campos manualmente desde el panel lateral.</p>
              </div>
            </div>
          )}
          {pdfDoc && (
            <div
              className="pdf-page"
              style={{ width: pageSize.width * zoom, height: pageSize.height * zoom }}
              onDoubleClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                addFieldFromDoubleClick((event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom);
              }}
            >
              <canvas className="pdf-canvas" ref={canvasRef} />
              <div className="field-layer" onPointerDown={() => setSelectedId("")}>
                {pageFields.map((field) => (
                  <div
                    key={field.id}
                    className={`pdf-field ${field.id === selectedId ? "is-selected" : ""} ${field.tipo === "firma" || field.tipo === "huella" ? "is-image" : ""}`}
                    style={{
                      left: field.x * zoom,
                      top: field.y * zoom,
                      width: field.w * zoom,
                      height: field.h * zoom,
                      fontSize: Math.max(8, field.fontSize * zoom)
                    }}
                    onPointerDown={(event) => startDrag(event, field)}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      setSelectedId(field.id);
                      if (field.tipo === "texto" || field.tipo === "checkbox") {
                        setEditingId(field.id);
                      }
                    }}
                    title={`${field.nombre} - confianza ${field.confianza.toFixed(2)}`}
                  >
                    <span className="field-content">
                      {editingId === field.id && (field.tipo === "texto" || field.tipo === "checkbox") ? (
                      <input
                        autoFocus
                        className="field-inline-input"
                        value={field.valor}
                        onPointerDown={(event) => event.stopPropagation()}
                        onChange={(event) => updateField(field.id, { valor: event.target.value })}
                        onBlur={() => setEditingId("")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === "Escape") {
                            event.preventDefault();
                            setEditingId("");
                          }
                        }}
                      />
                      ) : field.tipo === "firma" ? (
                        <img alt="Firma" src={transparentImages.firma} />
                      ) : field.tipo === "huella" ? (
                        <img alt="Huella" src={transparentImages.huella} />
                      ) : field.tipo === "checkbox" ? (
                        field.valor || "X"
                      ) : (
                        field.valor
                      )}
                    </span>
                    <button
                      className="field-resize"
                      type="button"
                      aria-label="Redimensionar campo"
                      onPointerDown={(event) => startResize(event, field)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="side-panel">
          <section className="px-panel">
            <div className="px-panel__header">
              <div>
                <h2 className="px-panel__title">Campos rapidos</h2>
                <p className="px-panel__copy">Selecciona uno y haz doble click en el PDF para repetirlo.</p>
              </div>
            </div>
            <div className="quick-list">
              {fieldOptions.map((option) => (
                <button
                  className={`quick-button ${selectedQuick?.key === option.key ? "is-active" : ""}`}
                  key={option.key}
                  type="button"
                  onClick={() => {
                    setSelectedQuick(option);
                    if (pdfDoc) addField(option);
                  }}
                >
                  <strong>{option.label}</strong>
                  <span>{option.type === "firma" || option.type === "huella" ? "imagen" : option.value || "(vacio)"}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="px-panel">
            <h2 className="px-panel__title">Pagina</h2>
            <div className="compact-row px-mt-4">
              <button className="px-btn px-btn--ghost px-btn--sm" disabled={!pdfDoc || pageNum === 0} onClick={() => setPageNum((value) => value - 1)}>
                Anterior
              </button>
              <span className="px-chip">Pagina {pageNum + 1} de {pdfDoc?.numPages || 0}</span>
              <button className="px-btn px-btn--ghost px-btn--sm" disabled={!pdfDoc || pageNum >= (pdfDoc?.numPages || 1) - 1} onClick={() => setPageNum((value) => value + 1)}>
                Siguiente
              </button>
            </div>
          </section>

          <section className="px-panel">
            <h2 className="px-panel__title">Campo seleccionado</h2>
            {!selectedField && <p className="px-panel__copy">Selecciona un campo sobre el PDF.</p>}
            {selectedField && (
              <div className="px-stack px-mt-4">
                <div className="edit-toolbar">
                  <button className="px-btn px-btn--ghost px-btn--sm" type="button" onClick={copySelectedField}>
                    Copiar
                  </button>
                  <button className="px-btn px-btn--ghost px-btn--sm" type="button" onClick={pasteCopiedField}>
                    Pegar
                  </button>
                  <button className="px-btn px-btn--ghost px-btn--sm" type="button" onClick={() => duplicateField(selectedField)}>
                    Duplicar
                  </button>
                  {(selectedField.tipo === "texto" || selectedField.tipo === "checkbox") && (
                    <button className="px-btn px-btn--ghost px-btn--sm" type="button" onClick={() => setEditingId(selectedField.id)}>
                      Editar en PDF
                    </button>
                  )}
                </div>
                <label className="px-field">
                  <span className="px-label">Nombre</span>
                  <input className="px-input" value={selectedField.nombre} onChange={(event) => updateField(selectedField.id, { nombre: event.target.value })} />
                </label>
                <label className="px-field">
                  <span className="px-label">Valor</span>
                  <input className="px-input" value={selectedField.valor} onChange={(event) => updateField(selectedField.id, { valor: event.target.value })} />
                </label>
                <div className="compact-row">
                  <label className="px-field">
                    <span className="px-label">Fuente</span>
                    <input className="px-input" type="number" min={6} max={18} value={selectedField.fontSize} onChange={(event) => updateField(selectedField.id, { fontSize: Number(event.target.value) })} />
                  </label>
                  <label className="px-field">
                    <span className="px-label">Ancho</span>
                    <input className="px-input" type="number" value={Math.round(selectedField.w)} onChange={(event) => updateField(selectedField.id, { w: Number(event.target.value) })} />
                  </label>
                  <label className="px-field">
                    <span className="px-label">Alto</span>
                    <input className="px-input" type="number" value={Math.round(selectedField.h)} onChange={(event) => updateField(selectedField.id, { h: Number(event.target.value) })} />
                  </label>
                </div>
                <button className="px-btn px-btn--ghost" type="button" onClick={() => removeField(selectedField.id)}>
                  Eliminar campo
                </button>
              </div>
            )}
            <p className="px-help px-mt-4">
              Atajos: flechas mueven, Shift+flechas mueve rapido, Ctrl+C copia, Ctrl+V pega, Ctrl+D duplica, Supr elimina.
              {copiedLabel ? ` Copiado: ${copiedLabel}.` : ""}
            </p>
          </section>

          <section className="px-panel">
            <h2 className="px-panel__title">Memoria local</h2>
            <p className="px-panel__copy">
              {memory ? `${Object.keys(memory.formulariosConocidos).length} formularios y ${memory.historialCorrecciones.length} correcciones en este navegador.` : "Cargando memoria..."}
            </p>
            <p className="px-help px-mt-4">
              Al generar, se guardan las coordenadas exactas confirmadas para que el mismo formato vuelva a caer en el mismo punto.
            </p>
            <button className="px-btn px-btn--ghost px-mt-4" type="button" onClick={() => setMemory(resetMemory())}>
              Restaurar semilla
            </button>
          </section>

          <section className="px-panel">
            <h2 className="px-panel__title">Como piensa la IA</h2>
            <p className="px-panel__copy">
              Mira cada pagina como imagen, busca lineas, espacios, checks, firma y huella. Luego compara el nombre del campo
              con los datos de Provexpress, aplica memoria local y deja todo editable para que lo ajustes.
            </p>
          </section>
        </aside>
      </section>
    </main>
  );
}
