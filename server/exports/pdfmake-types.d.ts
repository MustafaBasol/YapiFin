/**
 * YF-405 — pdfmake 0.3.11'in yayınladığı npm paketinde `.d.ts` yok ve
 * `@types/pdfmake` topluluk paketi eski (client-side `createPdf` API'sine
 * göre yazılmış) sürüm 0.3.x'in sunucu `Printer` API'sine uymuyor (font
 * spike ile doğrulanan gerçek API burada minimal ve doğru şekilde
 * tiplenir — bkz. server/exports/font.ts, server/exports/pdf-exporter.ts).
 */
declare module "pdfmake/js/Printer" {
  interface PdfFontDescriptor {
    normal: string;
    bold?: string;
    italics?: string;
    bolditalics?: string;
  }
  interface PdfPrinterFonts {
    [fontFamily: string]: PdfFontDescriptor;
  }
  interface PdfPrinterInstance {
    createPdfKitDocument(
      docDefinition: import("@/server/exports/pdf-doc-types").PdfDocDefinition,
      options?: Record<string, unknown>,
    ): Promise<NodeJS.ReadableStream & { end(): void }>;
  }
  interface PdfPrinterConstructor {
    new (fonts: PdfPrinterFonts, virtualfs?: unknown, urlResolver?: unknown, localAccessPolicy?: (path: string) => boolean): PdfPrinterInstance;
  }
  const PdfPrinterDefault: PdfPrinterConstructor;
  export default PdfPrinterDefault;
}

declare module "pdfmake/js/URLResolver" {
  interface URLResolverConstructor {
    new (fs: unknown): unknown;
  }
  const URLResolverDefault: URLResolverConstructor;
  export default URLResolverDefault;
}
