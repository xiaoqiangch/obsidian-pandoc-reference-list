import { getCacheRoot, debugLog } from '../helpers';

const path = require('path');
const fs = require('fs');

const STATE_FILE = 'conversion-state.json';

export interface ConversionState {
  citekey: string;
  attachmentPath: string;
  attachmentType: 'pdf' | 'epub';
  outputMdPath: string;
  bibPath: string;
  imagesDir: string;
  totalPages: number;
  convertedPages: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  error?: string;
}

interface StateMap {
  [citekey: string]: ConversionState;
}

export class ConversionStateManager {
  private stateMap: StateMap = {};
  private stateFilePath: string;

  constructor() {
    this.stateFilePath = path.join(getCacheRoot(), STATE_FILE);
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = fs.readFileSync(this.stateFilePath, 'utf-8');
        this.stateMap = JSON.parse(data);
      }
    } catch (e) {
      debugLog('ConverterState', 'Failed to load state file', e);
      this.stateMap = {};
    }
  }

  private save() {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.stateMap, null, 2), 'utf-8');
    } catch (e) {
      debugLog('ConverterState', 'Failed to save state file', e);
    }
  }

  get(citekey: string): ConversionState | null {
    return this.stateMap[citekey] || null;
  }

  set(citekey: string, state: ConversionState) {
    this.stateMap[citekey] = state;
    this.save();
  }

  update(citekey: string, partial: Partial<ConversionState>) {
    if (this.stateMap[citekey]) {
      this.stateMap[citekey] = { ...this.stateMap[citekey], ...partial };
      this.save();
    }
  }

  remove(citekey: string) {
    delete this.stateMap[citekey];
    this.save();
  }

  isCompleted(citekey: string): boolean {
    const state = this.stateMap[citekey];
    return state?.status === 'completed';
  }

  isInProgress(citekey: string): boolean {
    const state = this.stateMap[citekey];
    return state?.status === 'in_progress';
  }

  getOutputMdPath(citekey: string): string | null {
    return this.stateMap[citekey]?.outputMdPath || null;
  }

  getAll(): ConversionState[] {
    return Object.values(this.stateMap);
  }
}
