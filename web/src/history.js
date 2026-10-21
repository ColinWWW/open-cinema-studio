// Undo and redo for the editor: whole-scene snapshots (scenes are small JSON), newest last. The editor calls
// record() after each edit, where it saves; edits that share a `group` (one gizmo drag, typing in one field)
// merge into a single step, so Ctrl+Z undoes the whole drag rather than its last mouse move.

export const HISTORY_LIMIT = 100;

export class History {
  constructor(state, { limit = HISTORY_LIMIT } = {}) {
    this.limit = limit;
    this.reset(state);
  }

  /** Forget every step; `state` is the new starting point. */
  reset(state) {
    this.past = [];
    this.future = [];
    this.present = structuredClone(state);
    this.key = JSON.stringify(state);
    this.group = null;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /**
   * `state` was just edited. A step with the same non-null `group` as the one before it replaces that step.
   * Returns false when nothing changed (no step added).
   */
  record(state, group = null) {
    const key = JSON.stringify(state);
    if (key === this.key) return false;
    if (group === null || group !== this.group || !this.past.length) {
      this.past.push(this.present);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.present = structuredClone(state);
    this.key = key;
    this.group = group;
    this.future = [];
    return true;
  }

  /** The state before the last step (a copy to keep), or null when there is none. */
  undo() {
    if (!this.past.length) return null;
    this.future.push(this.present);
    return this.#move(this.past.pop());
  }

  /** The state the last undo went back from, or null. */
  redo() {
    if (!this.future.length) return null;
    this.past.push(this.present);
    return this.#move(this.future.pop());
  }

  #move(state) {
    this.present = state;
    this.key = JSON.stringify(state);
    this.group = null; // the next edit is a new step, even in the same field
    return structuredClone(state);
  }
}
