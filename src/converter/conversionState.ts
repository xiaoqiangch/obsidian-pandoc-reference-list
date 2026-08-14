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

  /**
   * Repair state left behind by a process that died mid-conversion.
   *
   * `in_progress` only ever means "a conversion is running *in this process*".
   * Nothing clears it when Obsidian quits, reloads the plugin, or the
   * conversion throws in a way that skips the catch block, so the flag leaks
   * and survives forever in the on-disk state file. Those leaked entries then
   * show up as 进行中 in the batch stats and — worse — are skipped by
   * buildBatchQueue, so the paper can never be converted again without a
   * manual force-reconvert.
   *
   * Called once at startup, before any conversion can begin, so every
   * `in_progress` entry it sees is by definition stale:
   *  - output md already on disk → the conversion actually finished
   *    (or finished enough to be usable) → mark `completed`;
   *  - no output → mark `failed` so it is picked up as pending again.
   *
   * Returns how many entries were repaired in each direction.
   */
  reconcileStaleInProgress(
    hasOutput: (state: ConversionState) => boolean
  ): { completed: number; failed: number } {
    let completed = 0;
    let failed = 0;

    for (const [citekey, state] of Object.entries(this.stateMap)) {
      if (state.status !== 'in_progress') continue;
      if (hasOutput(state)) {
        this.stateMap[citekey] = {
          ...state,
          status: 'completed',
          completedAt: state.completedAt || new Date().toISOString(),
        };
        completed++;
      } else {
        this.stateMap[citekey] = {
          ...state,
          status: 'failed',
          error: state.error || '转换被中断（插件重载或 Obsidian 退出），状态已重置',
        };
        failed++;
      }
    }

    if (completed || failed) {
      this.save();
      debugLog('ConverterState', 'Reconciled stale in_progress entries', {
        completed,
        failed,
      });
    }
    return { completed, failed };
  }
}
