"use client";

import { PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type Toast = {
  id: string;
  message: string;
  type: "success" | "info" | "error" | "warning";
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
  if (type === "checkbox") return { w: 20, h: 20 };
  return { w: 96, h: 20 };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

let measureContext: CanvasRenderingContext2D | null = null;

function getMeasureContext() {
  if (typeof document === "undefined") return null;
  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  return measureContext;
}

function fieldTextForSize(field: PdfField) {
  if (field.tipo === "checkbox") return field.valor || "X";
  if (field.tipo === "firma") return "Firma";
  if (field.tipo === "huella") return "Huella";
  return field.valor?.trim() || field.nombre?.trim() || "Campo";
}

function estimateFieldSize(field: PdfField, pageWidth = 595) {
  if (field.tipo === "firma" || field.tipo === "huella") return { w: field.w, h: field.h };

  const fontSize = clamp(Number(field.fontSize || 9), 6, 18);
  if (field.tipo === "checkbox") {
    const side = Math.max(16, Math.round(fontSize * 1.35));
    return { w: side, h: side };
  }

  const text = fieldTextForSize(field);
  const minWidth = Math.max(34, Math.round(fontSize * 2.3));
  const availableWidth = Math.max(minWidth, Math.floor(pageWidth - Number(field.x || 0) - 16));
  const context = getMeasureContext();
  let width = Math.ceil(text.length * fontSize * 0.58 + fontSize * 1.2);

  if (context) {
    context.font = `${Math.max(7, fontSize)}px Helvetica, Arial, sans-serif`;
    width = Math.ceil(context.measureText(text).width + Math.max(8, fontSize));
  }

  return {
    w: clamp(width, minWidth, availableWidth),
    h: clamp(Math.max(15, Math.round(fontSize * 1.5)), 15, 30)
  };
}

function autoSizeField(field: PdfField, pageWidth = 595, force = false): PdfField {
  if ((field.tipo !== "texto" && field.tipo !== "checkbox") || (!force && field.manualSize)) {
    return field;
  }

  const size = estimateFieldSize(field, pageWidth);
  return {
    ...field,
    w: size.w,
    h: size.h
  };
}

function autoSizeFields(fields: PdfField[], pageWidth = 595) {
  return fields.map((field) => autoSizeField(field, pageWidth));
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
    suggestedY: y,
    manualSize: false
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

function getConfidenceClass(field: PdfField): string {
  if (field.source === "manual") return "conf-manual";
  if (field.confianza >= 0.8) return "conf-high";
  if (field.confianza >= 0.5) return "conf-mid";
  return "conf-low";
}

function getConfidenceDotClass(field: PdfField): string {
  if (field.source === "manual") return "field-card-dot--manual";
  if (field.confianza >= 0.8) return "field-card-dot--high";
  if (field.confianza >= 0.5) return "field-card-dot--mid";
  return "field-card-dot--low";
}

function getTypeBadgeClass(tipo: FieldType): string {
  if (tipo === "checkbox") return "badge-check";
  if (tipo === "firma") return "badge-firma";
  if (tipo === "huella") return "badge-huella";
  return "badge-texto";
}

function getTypeBadgeLabel(tipo: FieldType): string {
  if (tipo === "checkbox") return "✓ Check";
  if (tipo === "firma") return "🖊 Firma";
  if (tipo === "huella") return "🖐 Huella";
  return "T Texto";
}

function getStatusInfo(status: string): { type: "analyzing" | "done" | "error" | "idle"; icon: string } {
  const lower = status.toLowerCase();
  if (lower.includes("analizando") || lower.includes("extrayendo") || lower.includes("generando") || lower.includes("cargando") || lower.includes("pagina")) {
    return { type: "analyzing", icon: "⚙️" };
  }
  if (lower.includes("generado") || lower.includes("memoria exacta") || lower.includes("detecto")) {
    return { type: "done", icon: "✅" };
  }
  if (lower.includes("error") || lower.includes("no pudo") || lower.includes("fallo")) {
    return { type: "error", icon: "❌" };
  }
  return { type: "idle", icon: "ℹ️" };
}

function getUserInitials(username: string): string {
  const parts = username.replace(/@.*/, "").split(/[.\s_-]/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("");
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

  // ── New UI state ──────────────────────────────────────────────────
  const [darkMode, setDarkMode] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [customFieldValue, setCustomFieldValue] = useState("");
  const [customFieldName, setCustomFieldName] = useState("");

  const selectedField = fields.find((field) => field.id === selectedId);
  const pageFields = fields.filter((field) => field.pageNum === pageNum);

  // ── Toast helper ──────────────────────────────────────────────────
  const addToast = useCallback((message: string, type: Toast["type"] = "info") => {
    const id = `toast_${Date.now()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const toastIcon = (type: Toast["type"]) => {
    if (type === "success") return "✅";
    if (type === "error") return "❌";
    if (type === "warning") return "⚠️";
    return "ℹ️";
  };

  // ── Effects ───────────────────────────────────────────────────────
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
    setFields((current) => autoSizeFields(current, pageSize.width));
  }, [pageSize.width]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape" && showModal) {
        setShowModal(false);
        return;
      }
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
  }, [selectedField, pageNum, pageSize.width, pageSize.height, showModal]);

  // ── Auth ──────────────────────────────────────────────────────────
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

  // ── PDF Logic (unchanged) ─────────────────────────────────────────
  async function openPdf(file: File) {
    setStatus("Cargando PDF...");
    setDownloadUrl("");
    const bytes = await file.arrayBuffer();
    const pdfjs = await loadPdfJs();
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
    const activeMemory = memory || loadMemory();
    if (!memory) setMemory(activeMemory);
    const firstPage = await document.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    const pdfText = await extractPdfText(document);
    const contentCode = detectCode(`${file.name}\n${pdfText}`);
    const fileCode = detectCode(file.name);
    const knownKey = activeMemory.formulariosConocidos[contentCode] ? contentCode : activeMemory.formulariosConocidos[fileCode] ? fileCode : "";

    setPdfBytes(bytes);
    setPdfDoc(document);
    setFileName(file.name);
    setCurrentMemoryKey(contentCode || fileCode);
    setPageNum(0);
    setPageSize({ width: firstViewport.width, height: firstViewport.height });
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
          suggestedY: field.y,
          manualSize: field.manualSize || false
        })),
        contractorData
      );
      setFields(autoSizeFields(remembered, firstViewport.width));
      setStatus(`Usando memoria exacta para ${knownKey}. No se aplicaron promedios ni offsets.`);
      addToast(`🧠 Memoria cargada — ${remembered.length} campos`, "success");
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
      suggestedY: y,
      manualSize: false
    };
    const sizedField = autoSizeField(field, pageSize.width, true);
    setFields((current) => [...current, sizedField]);
    setSelectedId(sizedField.id);
    setSelectedQuick(option);
    setDownloadUrl("");
    addToast(`➕ Campo agregado: ${option.label}`, "success");
    return sizedField.id;
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
    setFields((current) =>
      current.map((field) => {
        if (field.id !== id) return field;
        const sizeChanged = "w" in patch || "h" in patch;
        const contentChanged = "valor" in patch || "nombre" in patch || "fontSize" in patch || "tipo" in patch;
        const next = {
          ...field,
          ...patch,
          manualSize: sizeChanged ? true : field.manualSize
        };

        if (contentChanged && !next.manualSize) {
          return autoSizeField(next, pageSize.width, true);
        }

        return next;
      })
    );
    setDownloadUrl("");
  }

  function removeField(id: string) {
    const field = fields.find((f) => f.id === id);
    setFields((current) => current.filter((f) => f.id !== id));
    setSelectedId("");
    setEditingId("");
    setDownloadUrl("");
    if (field) addToast(`🗑️ Campo eliminado: ${field.nombre}`, "warning");
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
      suggestedY: field.y + dy,
      manualSize: field.manualSize || false
    };
    const sizedCopy = copy.manualSize ? copy : autoSizeField(copy, pageSize.width, true);
    setFields((current) => [...current, sizedCopy]);
    setSelectedId(sizedCopy.id);
    setEditingId("");
    setDownloadUrl("");
    addToast(`📋 Duplicado: ${sizedCopy.nombre}`, "info");
  }

  function autoFitSelectedField() {
    if (!selectedField) return;
    setFields((current) =>
      current.map((field) =>
        field.id === selectedField.id ? autoSizeField({ ...field, manualSize: false }, pageSize.width, true) : field
      )
    );
    setDownloadUrl("");
  }

  function copySelectedField() {
    if (!selectedField) return;
    copiedFieldRef.current = selectedField;
    setCopiedLabel(selectedField.nombre);
    addToast(`📋 Copiado: ${selectedField.nombre}`, "info");
  }

  function pasteCopiedField() {
    const copied = copiedFieldRef.current;
    if (!copied) {
      addToast("No hay campo copiado", "warning");
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
      h: nextH,
      manualSize: true
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
    setIsAnalyzing(true);
    const detected: PdfField[] = [];
    const activeMemory = memoryOverride || memory;

    try {
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
      const adjustedFields = activeMemory ? applyMemoryOffsets(activeMemory, completedFields) : completedFields;
      setFields(autoSizeFields(adjustedFields, pageSize.width));
      setStatus(`IA detecto ${detected.length} campos. Ajustalos sobre el PDF.`);
      addToast(`🤖 IA detectó ${detected.length} campos`, "success");
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function analyzeWithAi() {
    if (!pdfDoc) return;
    try {
      await analyzeDocument(pdfDoc);
    } catch (error) {
      setStatus(error instanceof Error ? `La IA no pudo analizar: ${error.message}` : "La IA no pudo analizar el PDF.");
      addToast("Error al analizar con IA", "error");
    }
  }

  async function generatePdf() {
    if (!pdfBytes) return;
    setStatus("Generando PDF...");
    setIsGenerating(true);
    try {
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
            suggestedY: field.y,
            manualSize: field.manualSize || false
          }))
        );
      }
      setStatus("PDF generado. La memoria local guardo estas posiciones exactas.");
      addToast("💾 PDF generado y listo para descargar", "success");
    } finally {
      setIsGenerating(false);
    }
  }

  // ── Computed values ───────────────────────────────────────────────
  const avgConfidence = fields.length > 0
    ? Math.round((fields.reduce((sum, f) => sum + f.confianza, 0) / fields.length) * 100)
    : 0;

  const statusInfo = getStatusInfo(status);

  // ── Add custom field from modal ──────────────────────────────────
  function addCustomField() {
    if (!customFieldName.trim()) return;
    const option: FieldOption = {
      key: "custom",
      label: customFieldName.trim(),
      type: "texto",
      value: customFieldValue.trim()
    };
    addField(option);
    setCustomFieldName("");
    setCustomFieldValue("");
    setShowModal(false);
  }

  // ═══════════════════════════════════════════════════════════════════
  // AUTH GATE
  // ═══════════════════════════════════════════════════════════════════
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
              <h1 className="px-title px-title--hero">Editor de PDFs<br />con Inteligencia Artificial</h1>
              <p className="px-copy">Rellena formularios automáticamente, revisa en el PDF y descarga el archivo listo en segundos.</p>
            </div>
            <div className="px-feature-list">
              <div className="px-feature"><span className="px-dot" /> Análisis automático con IA Gemini</div>
              <div className="px-feature"><span className="px-dot px-dot--purple" /> Memoria local sin base de datos</div>
              <div className="px-feature"><span className="px-dot" /> Login seguro con Microsoft 365</div>
            </div>
          </div>
          <div className="px-auth-action">
            <div className="px-logo px-logo--sm px-logo--brand">
              <img alt="Provexpress" src="/brand/provex-icon.png" />
            </div>
            <h2 className="px-title px-mt-4">Bienvenido de vuelta</h2>
            <p className="px-copy">Usa tu cuenta corporativa de Provexpress para acceder al editor.</p>
            <button className="px-btn px-btn--primary px-mt-4" type="button" onClick={loginMicrosoft} style={{ width: "100%" }}>
              <span>🔐</span> Continuar con Microsoft 365
            </button>
            <p className="px-help px-mt-4" style={{ textAlign: "center" }}>{authStatus}</p>
          </div>
        </section>
      </main>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // MAIN APP
  // ═══════════════════════════════════════════════════════════════════
  return (
    <main className={`app-frame${darkMode ? " is-dark" : ""}`}>

      {/* ── Topbar ─────────────────────────────────────────────────── */}
      <header className="px-topbar">
        <div className="topbar-left">
          <div className="px-logo px-logo--sm px-logo--brand">
            <img alt="Provexpress" src="/brand/provex-icon.png" />
          </div>
          <div className="px-brand__meta">
            <h1 className="px-brand__title">Provex Assistant</h1>
            <p className="px-brand__subtitle">Editor de PDFs · IA</p>
          </div>
        </div>

        <div className="topbar-right">
          <div className="topbar-user">
            <div className="topbar-user-avatar">{getUserInitials(account.username || "U")}</div>
            <span className="topbar-user-name">{account.username}</span>
          </div>
          <button
            className="dark-toggle"
            type="button"
            title={darkMode ? "Modo claro" : "Modo oscuro"}
            onClick={() => setDarkMode((v) => !v)}
          >
            {darkMode ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      {/* ── Stats Bar ──────────────────────────────────────────────── */}
      {pdfDoc && (
        <div className="stats-bar px-mt-4">
          <div className="stat-card">
            <div className="stat-icon stat-icon--blue">📄</div>
            <div className="stat-info">
              <span className="stat-value">{pdfDoc.numPages}</span>
              <span className="stat-label">Páginas</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon stat-icon--green">🔍</div>
            <div className="stat-info">
              <span className="stat-value">{fields.length}</span>
              <span className="stat-label">Campos detectados</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon stat-icon--purple">🎯</div>
            <div className="stat-info">
              <span className="stat-value">{avgConfidence}%</span>
              <span className="stat-label">Confianza promedio</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon stat-icon--amber">🧠</div>
            <div className="stat-info">
              <span className="stat-value">{memory ? Object.keys(memory.formulariosConocidos).length : 0}</span>
              <span className="stat-label">En memoria</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Status Alert ───────────────────────────────────────────── */}
      <div className={`status-alert px-mt-4 status-${statusInfo.type}`}>
        <span className="status-icon">{statusInfo.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span>{status}</span>
          {statusInfo.type === "analyzing" && (
            <div className="status-progress">
              <div className="status-progress-bar" style={{ width: "60%" }} />
            </div>
          )}
        </div>
      </div>

      {/* ── Editor Toolbar ─────────────────────────────────────────── */}
      <div className="editor-toolbar px-mt-4">
        <label className="toolbar-btn toolbar-btn--upload" title="Subir nuevo PDF">
          📂 Subir PDF
          <input hidden type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && openPdf(e.target.files[0])} />
        </label>

        <div className="toolbar-sep" />

        <button className="toolbar-btn" type="button" title="Reducir zoom" onClick={() => setZoom((v) => Math.max(0.7, v - 0.1))}>
          🔍−
        </button>
        <span className="toolbar-zoom-pill">{Math.round(zoom * 100)}%</span>
        <button className="toolbar-btn" type="button" title="Aumentar zoom" onClick={() => setZoom((v) => Math.min(3, v + 0.1))}>
          🔍+
        </button>

        <div className="toolbar-sep" />

        <button className="toolbar-btn" type="button" title="Copiar campo (Ctrl+C)" disabled={!selectedField} onClick={copySelectedField}>
          📋 Copiar
        </button>
        <button className="toolbar-btn" type="button" title="Pegar campo (Ctrl+V)" disabled={!copiedLabel} onClick={pasteCopiedField}>
          📌 Pegar
        </button>
        <button className="toolbar-btn" type="button" title="Duplicar campo (Ctrl+D)" disabled={!selectedField} onClick={() => selectedField && duplicateField(selectedField)}>
          ⧉ Duplicar
        </button>

        {selectedField && (selectedField.tipo === "texto" || selectedField.tipo === "checkbox") && (
          <button className="toolbar-btn" type="button" title="Editar valor directamente en el PDF" onClick={() => setEditingId(selectedField.id)}>
            ✏️ Editar
          </button>
        )}
        {selectedField && (selectedField.tipo === "texto" || selectedField.tipo === "checkbox") && (
          <button className="toolbar-btn" type="button" title="Ajustar tamaño al texto" onClick={autoFitSelectedField}>
            ↔️ Ajustar
          </button>
        )}

        <div className="toolbar-sep" />

        <button
          className="toolbar-btn toolbar-btn--primary"
          type="button"
          title="Analizar PDF con Inteligencia Artificial"
          disabled={!pdfDoc || isAnalyzing}
          onClick={analyzeWithAi}
        >
          {isAnalyzing ? <span className="btn-spinner" /> : "🤖"} Analizar IA
        </button>

        <button
          className="toolbar-btn toolbar-btn--accent"
          type="button"
          title="Generar PDF con los campos rellenados"
          disabled={!pdfBytes || !fields.length || isGenerating}
          onClick={generatePdf}
        >
          {isGenerating ? <span className="btn-spinner" /> : "⚡"} Generar PDF
        </button>

        {downloadUrl && (
          <a className="toolbar-btn toolbar-btn--accent" href={downloadUrl} download={`RELLENADO_${fileName || "formulario.pdf"}`} title="Descargar PDF generado">
            ⬇️ Descargar
          </a>
        )}
      </div>

      {/* ── Studio Shell ───────────────────────────────────────────── */}
      <section className="studio-shell px-mt-4">

        {/* ── PDF Stage ──────────────────────────────────────────── */}
        <div>
          <div
            className={`pdf-stage${isDraggingOver ? " is-drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }}
            onDragLeave={() => setIsDraggingOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file?.type === "application/pdf") openPdf(file);
            }}
          >
            {!pdfDoc && (
              <div
                className={`drop-zone${isDraggingOver ? " is-drag-over" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }}
              >
                <div>
                  <span className="drop-zone-icon">📄</span>
                  <h2 className="drop-zone-title">Arrastra tu formulario aquí</h2>
                  <p className="drop-zone-sub">
                    Deja que la IA haga el trabajo pesado. Detecta campos automáticamente y los rellena con los datos de Provexpress.
                  </p>
                  <label className="drop-zone-cta">
                    <span>📂</span> Seleccionar PDF
                    <input hidden type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && openPdf(e.target.files[0])} />
                  </label>
                </div>
              </div>
            )}

            {pdfDoc && (
              <div
                className="pdf-page"
                style={{ width: pageSize.width * zoom, height: pageSize.height * zoom }}
                onDoubleClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  addFieldFromDoubleClick((e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom);
                }}
              >
                <canvas className="pdf-canvas" ref={canvasRef} />
                <div className="field-layer" onPointerDown={() => setSelectedId("")}>
                  {pageFields.map((field) => (
                    <div
                      key={field.id}
                      className={`pdf-field ${getConfidenceClass(field)} ${field.id === selectedId ? "is-selected" : ""} ${field.tipo === "firma" || field.tipo === "huella" ? "is-image" : ""}`}
                      style={{
                        left: field.x * zoom,
                        top: field.y * zoom,
                        width: field.w * zoom,
                        height: field.h * zoom,
                        fontSize: Math.max(8, field.fontSize * zoom)
                      }}
                      onPointerDown={(e) => startDrag(e, field)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(field.id);
                        if (field.tipo === "texto" || field.tipo === "checkbox") {
                          setEditingId(field.id);
                        }
                      }}
                      title={`${field.nombre} · confianza ${Math.round(field.confianza * 100)}%`}
                    >
                      <span className="field-content">
                        {editingId === field.id && (field.tipo === "texto" || field.tipo === "checkbox") ? (
                          <input
                            autoFocus
                            className="field-inline-input"
                            value={field.valor}
                            onPointerDown={(e) => e.stopPropagation()}
                            onChange={(e) => updateField(field.id, { valor: e.target.value })}
                            onBlur={() => setEditingId("")}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === "Escape") {
                                e.preventDefault();
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

                      {/* Type icon badge */}
                      {field.tipo === "firma" && <span className="field-type-icon field-type-icon--firma">🖊</span>}
                      {field.tipo === "huella" && <span className="field-type-icon field-type-icon--huella">🖐</span>}
                      {field.tipo === "checkbox" && <span className="field-type-icon field-type-icon--check">✓</span>}

                      <button
                        className="field-resize"
                        type="button"
                        aria-label="Redimensionar campo"
                        onPointerDown={(e) => startResize(e, field)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Download card */}
          {downloadUrl && (
            <div className="download-card px-mt-4">
              <span className="download-card-icon">✅</span>
              <div className="download-card-body">
                <div className="download-card-title">{`RELLENADO_${fileName || "formulario.pdf"}`}</div>
                <div className="download-card-sub">{fields.length} campos completados · Listo para descargar</div>
              </div>
              <a className="download-btn" href={downloadUrl} download={`RELLENADO_${fileName || "formulario.pdf"}`}>
                ⬇️ Descargar
              </a>
            </div>
          )}
        </div>

        {/* ── Side Panel ─────────────────────────────────────────── */}
        <aside className="side-panel">

          {/* Campos detectados */}
          <section className="px-panel">
            <div className="px-panel__header">
              <div>
                <h2 className="px-panel__title">Campos detectados</h2>
                <p className="px-panel__copy">Haz clic para seleccionar un campo en el PDF.</p>
              </div>
              {fields.length > 0 && (
                <span className="px-chip">{fields.length}</span>
              )}
            </div>

            {fields.length === 0 ? (
              <p className="px-panel__copy">Sin campos. Sube un PDF y usa "Analizar IA".</p>
            ) : (
              <div className="field-list">
                {fields.map((field) => (
                  <button
                    key={field.id}
                    className={`field-card${field.id === selectedId ? " is-active" : ""}`}
                    onClick={() => {
                      setSelectedId(field.id);
                      setPageNum(field.pageNum);
                    }}
                    type="button"
                  >
                    <span className={`field-card-dot ${getConfidenceDotClass(field)}`} />
                    <div className="field-card-body">
                      <span className="field-card-name">{field.nombre}</span>
                      <span className="field-card-value">
                        {field.tipo === "firma" ? "imagen: firma" : field.tipo === "huella" ? "imagen: huella" : field.valor || "(vacío)"}
                      </span>
                    </div>
                    <span className={`field-card-badge ${getTypeBadgeClass(field.tipo)}`}>
                      {getTypeBadgeLabel(field.tipo)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Quick add chips */}
            <div style={{ marginTop: 14 }}>
              <p className="modal-section-label" style={{ marginBottom: 8 }}>Agregar campo rápido</p>
              <div className="quick-chips">
                {fieldOptions.slice(0, 6).map((opt) => (
                  <button
                    key={opt.key}
                    className={`quick-chip${selectedQuick?.key === opt.key ? " is-active" : ""}`}
                    type="button"
                    onClick={() => {
                      setSelectedQuick(opt);
                      if (pdfDoc) addField(opt);
                    }}
                  >
                    {opt.type === "firma" ? "🖊" : opt.type === "huella" ? "🖐" : opt.type === "checkbox" ? "✓" : "T"} {opt.label}
                  </button>
                ))}
                <button className="quick-chip" type="button" onClick={() => setShowModal(true)}>
                  ➕ Más…
                </button>
              </div>
            </div>
          </section>

          {/* Paginación */}
          <section className="px-panel">
            <h2 className="px-panel__title" style={{ marginBottom: 12 }}>Página</h2>
            <div className="page-nav">
              <button
                className="page-nav-btn"
                disabled={!pdfDoc || pageNum === 0}
                onClick={() => setPageNum((v) => v - 1)}
              >
                ← Anterior
              </button>
              <span className="page-indicator">
                {pageNum + 1} / {pdfDoc?.numPages || 0}
              </span>
              <button
                className="page-nav-btn"
                disabled={!pdfDoc || pageNum >= (pdfDoc?.numPages || 1) - 1}
                onClick={() => setPageNum((v) => v + 1)}
              >
                Siguiente →
              </button>
            </div>
          </section>

          {/* Campo seleccionado */}
          <section className="px-panel">
            <h2 className="px-panel__title" style={{ marginBottom: 12 }}>Campo seleccionado</h2>
            {!selectedField && <p className="px-panel__copy">Selecciona un campo sobre el PDF para editarlo.</p>}
            {selectedField && (
              <div className="field-editor">
                <div className="field-editor-actions">
                  <button className="px-btn px-btn--ghost px-btn--sm" type="button" title="Copiar campo" onClick={copySelectedField}>📋</button>
                  <button className="px-btn px-btn--ghost px-btn--sm" type="button" title="Pegar campo" onClick={pasteCopiedField}>📌</button>
                  <button className="px-btn px-btn--ghost px-btn--sm" type="button" title="Duplicar campo" onClick={() => duplicateField(selectedField)}>⧉</button>
                  {(selectedField.tipo === "texto" || selectedField.tipo === "checkbox") && (
                    <button className="px-btn px-btn--ghost px-btn--sm" type="button" title="Editar directamente en PDF" onClick={() => setEditingId(selectedField.id)}>✏️ Editar</button>
                  )}
                  {(selectedField.tipo === "texto" || selectedField.tipo === "checkbox") && (
                    <button className="px-btn px-btn--ghost px-btn--sm" type="button" title="Ajustar al contenido" onClick={autoFitSelectedField}>↔️</button>
                  )}
                  <button className="px-btn px-btn--sm" type="button" style={{ color: "var(--px-red)", borderColor: "rgba(198,40,40,0.25)", marginLeft: "auto" }} onClick={() => removeField(selectedField.id)}>🗑️</button>
                </div>

                <label className="px-field">
                  <span className="px-label">Nombre del campo</span>
                  <input className="px-input" value={selectedField.nombre} onChange={(e) => updateField(selectedField.id, { nombre: e.target.value })} />
                </label>

                <label className="px-field">
                  <span className="px-label">Valor</span>
                  <input className="px-input" value={selectedField.valor} onChange={(e) => updateField(selectedField.id, { valor: e.target.value })} />
                </label>

                <div className="field-editor-row">
                  <label className="px-field">
                    <span className="px-label">Fuente</span>
                    <input className="px-input" type="number" min={6} max={18} value={selectedField.fontSize} onChange={(e) => updateField(selectedField.id, { fontSize: Number(e.target.value) })} />
                  </label>
                  <label className="px-field">
                    <span className="px-label">Ancho</span>
                    <input className="px-input" type="number" value={Math.round(selectedField.w)} onChange={(e) => updateField(selectedField.id, { w: Number(e.target.value) })} />
                  </label>
                  <label className="px-field">
                    <span className="px-label">Alto</span>
                    <input className="px-input" type="number" value={Math.round(selectedField.h)} onChange={(e) => updateField(selectedField.id, { h: Number(e.target.value) })} />
                  </label>
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className={`field-card-badge ${getTypeBadgeClass(selectedField.tipo)}`} style={{ padding: "4px 10px", fontSize: "0.75rem" }}>
                    {getTypeBadgeLabel(selectedField.tipo)}
                  </span>
                  <span className="memory-stat">
                    🎯 {Math.round(selectedField.confianza * 100)}% confianza
                  </span>
                </div>

                <p className="px-help">
                  Flechas: mover · Shift+flechas: mover rápido · Ctrl+C/V: copiar/pegar · Ctrl+D: duplicar · Supr: eliminar
                  {copiedLabel ? ` · Portapapeles: ${copiedLabel}` : ""}
                </p>
              </div>
            )}
          </section>

          {/* Memoria */}
          <section className="px-panel">
            <h2 className="px-panel__title" style={{ marginBottom: 8 }}>Memoria local</h2>
            <p className="px-panel__copy">
              {memory
                ? `${Object.keys(memory.formulariosConocidos).length} formularios conocidos · ${memory.historialCorrecciones.length} correcciones guardadas`
                : "Cargando memoria..."}
            </p>
            <p className="px-help px-mt-4">
              Al generar un PDF, se aprenden las coordenadas exactas para que el mismo formulario se rellene perfectamente la próxima vez.
            </p>
            <button className="px-btn px-btn--ghost px-btn--sm px-mt-4" type="button" onClick={() => { setMemory(resetMemory()); addToast("🔄 Memoria restaurada", "info"); }}>
              🔄 Restaurar semilla
            </button>
          </section>

        </aside>
      </section>

      {/* ── Modal: Agregar campo ───────────────────────────────────── */}
      {showModal && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Agregar campo">
            <div className="modal-header">
              <h2 className="modal-title">➕ Agregar campo</h2>
              <button className="modal-close" type="button" onClick={() => setShowModal(false)} aria-label="Cerrar">✕</button>
            </div>
            <div className="modal-body">
              <p className="modal-section-label">Campos predefinidos</p>
              <div className="modal-grid">
                {fieldOptions.map((opt) => (
                  <button
                    key={opt.key}
                    className="modal-field-btn"
                    type="button"
                    onClick={() => {
                      setSelectedQuick(opt);
                      if (pdfDoc) addField(opt);
                      setShowModal(false);
                    }}
                  >
                    <span className="modal-field-name">
                      {opt.type === "firma" ? "🖊 " : opt.type === "huella" ? "🖐 " : opt.type === "checkbox" ? "✓ " : "T "}
                      {opt.label}
                    </span>
                    <span className="modal-field-value">
                      {opt.type === "firma" || opt.type === "huella" ? "imagen" : opt.value || "(vacío)"}
                    </span>
                  </button>
                ))}
              </div>

              <div className="modal-divider" />

              <p className="modal-section-label">Campo personalizado</p>
              <div style={{ display: "grid", gap: 10 }}>
                <label className="px-field">
                  <span className="px-label">Nombre del campo</span>
                  <input
                    className="px-input"
                    placeholder="Ej: Número de contrato"
                    value={customFieldName}
                    onChange={(e) => setCustomFieldName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addCustomField()}
                  />
                </label>
                <label className="px-field">
                  <span className="px-label">Valor</span>
                  <input
                    className="px-input"
                    placeholder="Ej: CT-2025-001"
                    value={customFieldValue}
                    onChange={(e) => setCustomFieldValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addCustomField()}
                  />
                </label>
                <button
                  className="px-btn px-btn--primary"
                  type="button"
                  disabled={!customFieldName.trim() || !pdfDoc}
                  onClick={addCustomField}
                  style={{ justifyContent: "center" }}
                >
                  Agregar campo al PDF
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast Notifications ────────────────────────────────────── */}
      <div className="toast-container" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" role="status">
            <span className="toast-icon">{toastIcon(toast.type)}</span>
            <span className="toast-msg">{toast.message}</span>
          </div>
        ))}
      </div>

    </main>
  );
}
