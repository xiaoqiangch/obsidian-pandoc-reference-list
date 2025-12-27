export interface PartialCSLEntry {
  id: string;
  type: string;
  title: string;
  author?: Array<{ family?: string; given?: string }>;
  year?: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  volume?: string;
  number?: string;
  pages?: string;
  doi?: string;
  url?: string;
  file?: string;
  keywords?: string;
  abstract?: string;
  note?: string;
  groupID?: number;
  line?: number;
  sourceFile?: string;
  addDate?: string;
}

export type CSLList = PartialCSLEntry[];
