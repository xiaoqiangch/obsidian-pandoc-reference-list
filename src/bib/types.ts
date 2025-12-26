export interface PartialCSLEntry {
  id: string;
  title: string;
  author?: Array<{ family?: string; given?: string }>;
  groupID?: number;
}

export type CSLList = PartialCSLEntry[];
