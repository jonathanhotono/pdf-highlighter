import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Plus, Trash2, FileJson, FileText, Play } from "lucide-react";
import { motion } from "framer-motion";

// --- PDF.js setup -----------------------------------------------------------
// Root cause fix: the workerSrc must be a STRING url. Importing the worker module
// can yield an ESM object depending on bundler, causing "Invalid workerSrc type".
// We set a CDN url explicitly (works across bundlers). If you prefer local assets,
// replace with something like:
//   GlobalWorkerOptions.workerSrc = new URL(
//     'pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url
//   ).toString();
import { getDocument, GlobalWorkerOptions, type PDFPageProxy } from "pdfjs-dist";
GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

// -------------------- Types -------------------------------------------------
// Azure Doc Intelligence polygons typically come in inches (unit:"inch") with
// TOP-LEFT origin. Each word has: { name, polygon:[x1,y1,x2,y2,x3,y3,x4,y4], page }
// This app also supports normalized (0..1) and PDF points (1/72") inputs.

type RectUnit = "inch" | "ratio" | "pdf"; // ratio = normalized 0..1 of page width/height

type BBoxRect = {
  id: string;
  page: number; // 1-based
  x: number; // left in unit
  y: number; // top in unit (top-origin for inch/ratio; bottom-origin for pdf)
  width: number;
  height: number;
  unit: RectUnit;
  label?: string;
  color?: string; // optional custom color per rect
};

// -------------------- Helpers ----------------------------------------------
function fileToObjectUrl(file: File) {
  return URL.createObjectURL(file);
}

function polygonsToRects(
  items: { page: number; polygon: number[]; label?: string }[],
  unit: RectUnit
): BBoxRect[] {
  return items.map((it, idx) => {
    const p = it.polygon;
    if (!p || p.length < 8) throw new Error("Polygon must have 4 points (8 values)");
    const xs = [p[0], p[2], p[4], p[6]];
    const ys = [p[1], p[3], p[5], p[7]];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      id: `poly-${it.page}-${idx}`,
      page: it.page,
      x: minX,
      y: minY, // NOTE: for inch/ratio we treat y as TOP-origin; we'll flip later
      width: maxX - minX,
      height: maxY - minY,
      unit,
      label: it.label,
    };
  });
}

// Convert Rect (inch/ratio/pdf) to PDF user-space points [left,bottom,right,top]
// *inch/ratio are TOP-left origin → flipped to bottom-left using page height.
export function rectToPdfPoints(
  rect: BBoxRect,
  pageSizePts: { width: number; height: number }
) {
  if (rect.unit === "pdf") {
    return {
      left: rect.x,
      bottom: rect.y,
      right: rect.x + rect.width,
      top: rect.y + rect.height,
    };
  }
  if (rect.unit === "inch") {
    const leftInPts = rect.x * 72;
    const topInPts = rect.y * 72; // still top-origin
    const rightInPts = (rect.x + rect.width) * 72;
    const bottomInPts = (rect.y + rect.height) * 72;
    const h = pageSizePts.height;
    return {
      left: leftInPts,
      right: rightInPts,
      bottom: h - bottomInPts,
      top: h - topInPts,
    };
  }
  // ratio (0..1), TOP-left
  const leftPts = rect.x * pageSizePts.width;
  const topPts = rect.y * pageSizePts.height;
  const rightPts = (rect.x + rect.width) * pageSizePts.width;
  const bottomPts = (rect.y + rect.height) * pageSizePts.height;
  const h = pageSizePts.height;
  return {
    left: leftPts,
    right: rightPts,
    bottom: h - bottomPts,
    top: h - topPts,
  };
}

// Convert a Rect → viewport-space box (CSS px, TOP-LEFT origin), rotation-safe.
function rectToViewport(
  rect: BBoxRect,
  viewport: any /* PDFPageViewport */,
  pageSizePts: { width: number; height: number }
) {
  const { left, right, bottom, top } = rectToPdfPoints(rect, pageSizePts);
  const [vx1, vy1] = viewport.convertToViewportPoint(left, top);
  const [vx2, vy2] = viewport.convertToViewportPoint(right, bottom);
  const vLeft = Math.min(vx1, vx2);
  const vTop = Math.min(vy1, vy2);
  const width = Math.abs(vx2 - vx1);
  const height = Math.abs(vy2 - vy1);
  return { left: vLeft, top: vTop, width, height };
}

// Attempt to parse the uploaded JSON as the sample Azure DI-like structure.
function parseUploadedAzureJson(raw: any): BBoxRect[] {
  const rects: BBoxRect[] = [];
  // Try shape: { analysisResult:[ { matchingWords:[ { page, words:[{ name, polygon:[...]}] } ] } ] }
  const results = raw?.analysisResult ?? [];
  for (const res of results) {
    const mw = res?.matchingWords ?? [];
    for (const m of mw) {
      const page = m?.page ?? m?.words?.[0]?.page;
      const words = m?.words ?? [];
      for (const w of words) {
        if (!w?.polygon || !Array.isArray(w.polygon)) continue;
        rects.push({
          id: crypto.randomUUID(),
          page: w.page ?? page ?? 1,
          x: Math.min(w.polygon[0], w.polygon[2], w.polygon[4], w.polygon[6]),
          y: Math.min(w.polygon[1], w.polygon[3], w.polygon[5], w.polygon[7]),
          width:
            Math.max(w.polygon[0], w.polygon[2], w.polygon[4], w.polygon[6]) -
            Math.min(w.polygon[0], w.polygon[2], w.polygon[4], w.polygon[6]),
          height:
            Math.max(w.polygon[1], w.polygon[3], w.polygon[5], w.polygon[7]) -
            Math.min(w.polygon[1], w.polygon[3], w.polygon[5], w.polygon[7]),
          unit: "inch", // uploaded sample looks like inches
          label: w.name,
        });
      }
    }
  }
  return rects;
}

// -------------------- Tiny Test Harness ------------------------------------
// We don't have formal tests here, so include a minimal in-app test runner that
// validates the math for rectToPdfPoints and JSON parsing.

type TestResult = { name: string; pass: boolean; details?: string };

function runUnitTests(): TestResult[] {
  const out: TestResult[] = [];
  const page = { width: 612, height: 792 }; // Letter (8.5x11in)

  // 1) inch → pdf points flip
  {
    const r: BBoxRect = { id: "t1", page: 1, unit: "inch", x: 1, y: 1, width: 2, height: 1 };
    const got = rectToPdfPoints(r, page);
    const exp = { left: 72, right: 216, bottom: 648, top: 720 }; // 1in margins, h=792
    const pass =
      Math.abs(got.left - exp.left) < 0.001 &&
      Math.abs(got.right - exp.right) < 0.001 &&
      Math.abs(got.bottom - exp.bottom) < 0.001 &&
      Math.abs(got.top - exp.top) < 0.001;
    out.push({ name: "inch→pdf flip", pass, details: JSON.stringify({ got, exp }) });
  }

  // 2) ratio → pdf points flip
  {
    const r: BBoxRect = { id: "t2", page: 1, unit: "ratio", x: 0.5, y: 0.5, width: 0.25, height: 0.25 };
    const got = rectToPdfPoints(r, page);
    const exp = { left: 306, right: 459, bottom: 198, top: 396 }; // see analysis
    const pass =
      Math.abs(got.left - exp.left) < 0.001 &&
      Math.abs(got.right - exp.right) < 0.001 &&
      Math.abs(got.bottom - exp.bottom) < 0.001 &&
      Math.abs(got.top - exp.top) < 0.001;
    out.push({ name: "ratio→pdf flip", pass, details: JSON.stringify({ got, exp }) });
  }

  // 3) pdf → passthrough
  {
    const r: BBoxRect = { id: "t3", page: 1, unit: "pdf", x: 10, y: 20, width: 30, height: 40 };
    const got = rectToPdfPoints(r, page);
    const exp = { left: 10, right: 40, bottom: 20, top: 60 };
    const pass =
      got.left === exp.left && got.right === exp.right && got.bottom === exp.bottom && got.top === exp.top;
    out.push({ name: "pdf passthrough", pass, details: JSON.stringify({ got, exp }) });
  }

  // 4) polygonsToRects basic
  {
    const polyRects = polygonsToRects(
      [
        { page: 1, polygon: [1, 1, 3, 1, 3, 2, 1, 2] }, // 2x1 box
        { page: 2, polygon: [0, 0, 1, 0, 1, 1, 0, 1] }, // 1x1 box
      ],
      "inch"
    );
    const pass =
      polyRects.length === 2 &&
      Math.abs(polyRects[0].x - 1) < 1e-9 &&
      Math.abs(polyRects[0].y - 1) < 1e-9 &&
      Math.abs(polyRects[0].width - 2) < 1e-9 &&
      Math.abs(polyRects[0].height - 1) < 1e-9;
    out.push({ name: "polygons→rects", pass });
  }

  return out;
}

// -------------------- Main Component ---------------------------------------
export default function PDFOverlayApp() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [scale, setScale] = useState<number>(1.5);
  const [rects, setRects] = useState<BBoxRect[]>([]);
  const [unit, setUnit] = useState<RectUnit>("inch");
  const [jsonText, setJsonText] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pdfFile) return;
    const url = fileToObjectUrl(pdfFile);
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pdfFile]);

  // Render PDF pages and overlay
  useEffect(() => {
    (async () => {
      if (!pdfUrl || !containerRef.current) return;
      setLoading(true);
      const container = containerRef.current;
      container.innerHTML = "";

      const loadingTask = getDocument(pdfUrl);
      const pdf = await loadingTask.promise;

      for (let p = 1; p <= pdf.numPages; p++) {
        const page: PDFPageProxy = await pdf.getPage(p);
        const baseViewport = page.getViewport({ scale: 1, rotation: page.rotate });
        const viewport = page.getViewport({ scale, rotation: page.rotate });

        // --- Canvas render ---
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const pageWrap = document.createElement("div");
        pageWrap.style.position = "relative";
        pageWrap.style.width = `${viewport.width}px`;
        pageWrap.style.height = `${viewport.height}px`;
        pageWrap.className = "mb-6 rounded-2xl shadow border bg-white";

        const pageBadge = document.createElement("div");
        pageBadge.textContent = `Page ${p}`;
        pageBadge.className =
          "absolute left-2 top-2 text-xs px-2 py-0.5 rounded bg-black/60 text-white z-20";

        pageWrap.appendChild(canvas);
        pageWrap.appendChild(pageBadge);
        container.appendChild(pageWrap);

        await page.render({ canvasContext: ctx, viewport }).promise;

        // --- SVG overlay ---
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", String(viewport.width));
        svg.setAttribute("height", String(viewport.height));
        svg.style.position = "absolute";
        svg.style.left = "0";
        svg.style.top = "0";
        svg.style.pointerEvents = "none";
        pageWrap.appendChild(svg);

        const pageRects = rects.filter((r) => r.page === p);
        for (const r of pageRects) {
          const box = rectToViewport(r, viewport, {
            width: baseViewport.width,
            height: baseViewport.height,
          });
          const rectEl = document.createElementNS(svgNS, "rect");
          rectEl.setAttribute("x", box.left.toFixed(2));
          rectEl.setAttribute("y", box.top.toFixed(2));
          rectEl.setAttribute("width", box.width.toFixed(2));
          rectEl.setAttribute("height", box.height.toFixed(2));
          rectEl.setAttribute("rx", "3");
          rectEl.setAttribute(
            "fill",
            r.color ? `${r.color}40` : "rgba(255, 230, 0, 0.25)"
          );
          rectEl.setAttribute("stroke", r.color || "rgba(255, 160, 0, 0.95)");
          rectEl.setAttribute("stroke-width", "2");
          svg.appendChild(rectEl);

          if (r.label) {
            const label = document.createElementNS(svgNS, "text");
            label.setAttribute("x", (box.left + 4).toFixed(2));
            label.setAttribute("y", (box.top + 12).toFixed(2));
            label.textContent = r.label;
            label.setAttribute("font-size", "11");
            label.setAttribute("fill", "#111");
            label.setAttribute("opacity", "0.9");
            svg.appendChild(label);
          }
        }
      }
      setLoading(false);
    })();
  }, [pdfUrl, scale, rects]);

  // Handlers -------------------------------------------------
  const handleJsonUpload = async (file: File) => {
    const text = await file.text();
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      const autoRects = parseUploadedAzureJson(parsed);
      setRects((prev) => [...prev, ...autoRects]);
      setUnit("inch");
    } catch (e) {
      console.error(e);
      alert("Could not parse JSON. Paste or shape it per the sample.");
    }
  };

  const handleManualAdd = () => {
    setRects((prev) => [
      ...prev,
      { id: crypto.randomUUID(), page: 1, x: 1, y: 1, width: 1.5, height: 0.5, unit },
    ]);
  };

  const updateRect = (id: string, patch: Partial<BBoxRect>) => {
    setRects((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRect = (id: string) => {
    setRects((prev) => prev.filter((r) => r.id !== id));
  };

  const runTestsNow = () => {
    const results = runUnitTests();
    setTestResults(results);
  };

  return (
    <div className="w-full min-h-screen grid grid-cols-12 gap-4 p-4 bg-slate-50">
      {/* Left: Controls */}
      <div className="col-span-12 lg:col-span-4 space-y-4">
        <Card className="shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">1) Load PDF & JSON</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label className="text-sm">PDF File</Label>
            <div className="flex items-center gap-2">
              <Input
                type="file"
                accept="application/pdf"
                onChange={(e) => e.target.files?.[0] && setPdfFile(e.target.files[0])}
              />
              <Button variant="secondary" className="gap-2">Pick PDF</Button>
            </div>

            <Label className="text-sm">Azure DI JSON (optional)</Label>
            <div className="flex items-center gap-2">
              <Input
                type="file"
                accept="application/json"
                onChange={(e) => e.target.files?.[0] && handleJsonUpload(e.target.files[0])}
              />
              <Button variant="secondary" className="gap-2"><FileJson size={16}/>Pick JSON</Button>
            </div>

            <Label className="text-sm">Or paste JSON</Label>
            <Textarea
              placeholder="Paste Azure DI-like JSON here"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              className="h-28"
            />
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  try {
                    const parsed = JSON.parse(jsonText);
                    const autoRects = parseUploadedAzureJson(parsed);
                    setRects((prev) => [...prev, ...autoRects]);
                    setUnit("inch");
                  } catch (e) {
                    alert("Invalid JSON");
                  }
                }}
              >
                Import from JSON
              </Button>
              <Button variant="outline" onClick={() => { setRects([]); }}>Clear Overlays</Button>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">2) Zoom & Units</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label>Zoom: {scale.toFixed(2)}×</Label>
            <Slider
              value={[scale]}
              min={0.5}
              max={3}
              step={0.1}
              onValueChange={(v) => setScale(v[0])}
            />

            <Label>Rect Unit (for manual edits)</Label>
            <Select value={unit} onValueChange={(v) => setUnit(v as RectUnit)}>
              <SelectTrigger>
                <SelectValue placeholder="Unit" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inch">inch (TOP-left, Azure DI)</SelectItem>
                <SelectItem value="ratio">ratio 0..1 (TOP-left)</SelectItem>
                <SelectItem value="pdf">pdf points (BOTTOM-left)</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card className="shadow">
          <CardHeader className="pb-2 flex items-center justify-between">
            <CardTitle className="text-lg">3) Overlays</CardTitle>
            <Button size="sm" className="gap-1" onClick={handleManualAdd}><Plus size={16}/>Add</Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {rects.length === 0 && (
              <div className="text-sm text-slate-500">No rectangles yet. Import JSON or click Add.</div>
            )}
            <div className="space-y-3 max-h-[40vh] overflow-auto pr-1">
              {rects.map((r) => (
                <motion.div
                  key={r.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="border rounded-xl p-3 bg-white/70 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">Rect #{r.id.slice(0, 6)}</div>
                    <Button size="icon" variant="ghost" onClick={() => removeRect(r.id)}>
                      <Trash2 size={16} />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <Label className="text-xs">Page</Label>
                      <Input type="number" value={r.page} onChange={(e) => updateRect(r.id, { page: parseInt(e.target.value || "1", 10) })}/>
                    </div>
                    <div>
                      <Label className="text-xs">Unit</Label>
                      <Select value={r.unit} onValueChange={(v) => updateRect(r.id, { unit: v as RectUnit })}>
                        <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="inch">inch</SelectItem>
                          <SelectItem value="ratio">ratio</SelectItem>
                          <SelectItem value="pdf">pdf</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">X</Label>
                      <Input type="number" step="0.01" value={r.x} onChange={(e) => updateRect(r.id, { x: parseFloat(e.target.value || "0") })}/>
                    </div>
                    <div>
                      <Label className="text-xs">Y</Label>
                      <Input type="number" step="0.01" value={r.y} onChange={(e) => updateRect(r.id, { y: parseFloat(e.target.value || "0") })}/>
                    </div>
                    <div>
                      <Label className="text-xs">Width</Label>
                      <Input type="number" step="0.01" value={r.width} onChange={(e) => updateRect(r.id, { width: parseFloat(e.target.value || "0") })}/>
                    </div>
                    <div>
                      <Label className="text-xs">Height</Label>
                      <Input type="number" step="0.01" value={r.height} onChange={(e) => updateRect(r.id, { height: parseFloat(e.target.value || "0") })}/>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Label (optional)</Label>
                      <Input value={r.label ?? ""} onChange={(e) => updateRect(r.id, { label: e.target.value })}/>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Color (CSS)</Label>
                      <Input placeholder="#ff9900" value={r.color ?? ""} onChange={(e) => updateRect(r.id, { color: e.target.value })}/>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow">
          <CardHeader className="pb-2 flex items-center justify-between">
            <CardTitle className="text-lg">4) Tests</CardTitle>
            <Button size="sm" className="gap-1" onClick={runTestsNow}><Play size={16}/>Run tests</Button>
          </CardHeader>
          <CardContent>
            {testResults ? (
              <ul className="text-sm space-y-1">
                {testResults.map((t, i) => (
                  <li key={i} className={t.pass ? "text-emerald-700" : "text-rose-700"}>
                    {t.pass ? "PASS" : "FAIL"} — {t.name}
                    {t.details ? <span className="block text-xs text-slate-500">{t.details}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-slate-500">No tests run yet.</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Right: PDF viewport */}
      <div className="col-span-12 lg:col-span-8">
        <Card className="shadow">
          <CardHeader className="pb-2 flex items-center gap-2">
            <FileText size={18} />
            <CardTitle className="text-lg">Preview</CardTitle>
          </CardHeader>
          <CardContent>
            {!pdfUrl ? (
              <div className="text-sm text-slate-500">Upload a PDF to begin.</div>
            ) : (
              <div ref={containerRef} className="relative" />
            )}
            {loading && (
              <div className="mt-3 text-sm text-slate-500">Rendering…</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
