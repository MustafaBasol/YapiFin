/**
 * YF-405 — pdfmake docDefinition için kullandığımız alanların minimal,
 * doğru tipleri (pdfmake'in tam içerik modeli çok daha geniştir; burada
 * yalnızca bu dosyalarda üretilen rapor belgeleri için gerekenler
 * tiplenir).
 */
export interface PdfTextNode {
  text: string | PdfTextNode[];
  style?: string;
  bold?: boolean;
  italics?: boolean;
  fontSize?: number;
  color?: string;
  alignment?: "left" | "right" | "center" | "justify";
  margin?: [number, number, number, number] | [number, number] | number;
  decoration?: string;
}

export interface PdfTableNode {
  table: {
    headerRows?: number;
    widths?: (string | number)[];
    body: (string | PdfTextNode)[][];
    dontBreakRows?: boolean;
  };
  layout?: string | Record<string, unknown>;
  margin?: [number, number, number, number] | [number, number] | number;
}

export type PdfContent = string | PdfTextNode | PdfTableNode | PdfContent[] | { text: string; style?: string; margin?: number[] };

export interface PdfDocDefinition {
  pageSize?: string;
  pageOrientation?: "portrait" | "landscape";
  pageMargins?: [number, number, number, number] | number;
  defaultStyle?: { font?: string; fontSize?: number };
  styles?: Record<string, Partial<PdfTextNode>>;
  content: PdfContent[];
  footer?: (currentPage: number, pageCount: number) => PdfContent;
  info?: { title?: string; author?: string };
  version?: string;
  compress?: boolean;
}
