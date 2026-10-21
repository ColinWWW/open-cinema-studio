// In-app confirm dialog: replaces the browser's native confirm box, which looks rough on video and
// blocks automated browsers. confirmDialog(message) resolves true (OK) or false (Cancel, Esc or a click outside).
// The logic takes its elements as arguments, so test/dialog.test.js runs it in node with fakes.

/** What a key does while the dialog is open: 'confirm', 'cancel', 'trap' (Tab) or null. */
export function dialogKey(key) {
  if (key === 'Enter') return 'confirm';
  if (key === 'Escape' || key === 'Esc') return 'cancel';
  if (key === 'Tab') return 'trap';
  return null;
}

/** The element Tab (or Shift+Tab) moves to, wrapping inside the dialog so focus never leaves it. */
export function nextFocus(focusables, active, back = false) {
  if (!focusables.length) return null;
  const i = focusables.indexOf(active);
  if (i < 0) return back ? focusables[focusables.length - 1] : focusables[0];
  return focusables[(i + (back ? -1 : 1) + focusables.length) % focusables.length];
}

/**
 * Wires a confirm dialog to its elements: the backdrop (`root`, hidden while closed), the box inside it,
 * the message line and the two buttons. Returns ask(message, { ok, cancel }) => Promise<boolean>.
 */
export function createConfirm({ root, box, message, ok, cancel, doc = globalThis.document }) {
  let settle = null;
  let returnFocus = null;

  const close = (answer) => {
    if (!settle) return;
    const done = settle;
    settle = null;
    root.hidden = true;
    returnFocus?.focus?.();
    returnFocus = null;
    done(answer);
  };

  ok.addEventListener('click', () => close(true));
  cancel.addEventListener('click', () => close(false));
  root.addEventListener('click', (e) => {
    if (e.target === root) close(false);
  });
  // Handled on the dialog and stopped there, so the editor's shortcuts (Delete, Space, Esc…) never see it.
  root.addEventListener('keydown', (e) => {
    const action = dialogKey(e.key);
    e.stopPropagation();
    if (!action) return;
    e.preventDefault();
    if (action === 'trap') nextFocus([cancel, ok], doc.activeElement, e.shiftKey)?.focus();
    // Enter presses the focused button, which is OK unless the user tabbed to Cancel.
    else if (action === 'confirm') close(doc.activeElement !== cancel);
    else close(false);
  });
  // A click that lands elsewhere can't take focus out of the open dialog.
  doc.addEventListener?.('focusin', (e) => {
    if (settle && !box.contains(e.target)) ok.focus();
  });

  return function ask(text, { ok: okLabel = 'OK', cancel: cancelLabel = 'Cancel' } = {}) {
    close(false); // a second request answers the first one with Cancel
    message.textContent = text;
    ok.textContent = okLabel;
    cancel.textContent = cancelLabel;
    returnFocus = doc.activeElement;
    root.hidden = false;
    ok.focus();
    return new Promise((resolve) => { settle = resolve; });
  };
}

let shared = null;
/** The page's dialog (#dialog in index.html). */
export function confirmDialog(text, labels) {
  if (!shared) {
    const $ = (id) => document.getElementById(id);
    shared = createConfirm({ root: $('dialog'), box: $('dialog-box'), message: $('dialog-message'), ok: $('dialog-ok'), cancel: $('dialog-cancel') });
  }
  return shared(text, labels);
}
