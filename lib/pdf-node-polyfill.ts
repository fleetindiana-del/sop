/**
 * pdfjs-dist (used by pdf-parse v2) expects browser geometry APIs.
 * In Node it tries to load @napi-rs/canvas via createRequire(import.meta.url),
 * which fails when Next/Turbopack externalizes pdf-parse into a hashed chunk.
 * Install the polyfills on globalThis *before* importing pdf-parse.
 */

type PdfDomName = "DOMMatrix" | "ImageData" | "Path2D";

let pending: Promise<void> | null = null;

function getPdfDomGlobal(name: PdfDomName): unknown {
  return (globalThis as Record<string, unknown>)[name];
}

function setPdfDomGlobal(name: PdfDomName, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function installDomMatrixStub(): void {
  class DOMMatrixStub {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    m11 = 1;
    m12 = 0;
    m13 = 0;
    m14 = 0;
    m21 = 0;
    m22 = 1;
    m23 = 0;
    m24 = 0;
    m31 = 0;
    m32 = 0;
    m33 = 1;
    m34 = 0;
    m41 = 0;
    m42 = 0;
    m43 = 0;
    m44 = 1;
    is2D = true;
    isIdentity = true;

    static fromMatrix() {
      return new DOMMatrixStub();
    }
    static fromFloat32Array() {
      return new DOMMatrixStub();
    }
    static fromFloat64Array() {
      return new DOMMatrixStub();
    }

    multiply() {
      return new DOMMatrixStub();
    }
    multiplySelf() {
      return this;
    }
    preMultiplySelf() {
      return this;
    }
    inverse() {
      return new DOMMatrixStub();
    }
    invertSelf() {
      return this;
    }
    translate() {
      return new DOMMatrixStub();
    }
    translateSelf() {
      return this;
    }
    scale() {
      return new DOMMatrixStub();
    }
    scaleSelf() {
      return this;
    }
    rotateSelf() {
      return this;
    }
    transformPoint(point?: { x?: number; y?: number; z?: number; w?: number }) {
      return { x: point?.x ?? 0, y: point?.y ?? 0, z: point?.z ?? 0, w: point?.w ?? 1 };
    }
  }

  setPdfDomGlobal("DOMMatrix", DOMMatrixStub);
}

export async function ensurePdfNodePolyfills(): Promise<void> {
  if (typeof getPdfDomGlobal("DOMMatrix") !== "undefined") return;
  if (pending) return pending;

  pending = (async () => {
    try {
      const canvas = (await import("@napi-rs/canvas")) as unknown as {
        DOMMatrix?: unknown;
        ImageData?: unknown;
        Path2D?: unknown;
      };
      if (canvas.DOMMatrix) setPdfDomGlobal("DOMMatrix", canvas.DOMMatrix);
      if (canvas.ImageData) setPdfDomGlobal("ImageData", canvas.ImageData);
      if (canvas.Path2D) setPdfDomGlobal("Path2D", canvas.Path2D);
    } catch (err) {
      console.warn("[pdf] @napi-rs/canvas unavailable; using DOMMatrix stub", err);
    }

    if (typeof getPdfDomGlobal("DOMMatrix") === "undefined") {
      installDomMatrixStub();
    }
  })();

  try {
    await pending;
  } finally {
    pending = null;
  }
}
