import type { ContentBlock } from "../../shared/types";

export type { ContentBlock };

export interface ParsedChapter {
  index: number;
  title: string;
  rawText: string;
}

export interface ParsedEpub {
  title: string;
  author: string;
  chapters: ParsedChapter[];
}

export interface EpubCover {
  data: Buffer;
  ext: string;
}

export interface EpubMeta {
  title: string;
  author: string;
  cover: EpubCover | null;
}

export interface LinkTarget {
  chapterIndex: number;
  fragment?: string;
}

export const XHTML_NS = "http://www.w3.org/1999/xhtml";
export const MAX_EXTRACTED_IMAGES = 500;
export const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024;
