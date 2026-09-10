import { state } from './state.js';
import { t } from './messages.js';

export const STEP_DOT_WINDOW = 5;

export function visibleStepWindow(total, currentIndex, windowSize = STEP_DOT_WINDOW) {
  const totalCount = Math.max(0, Number(total) || 0);
  const size = Math.max(1, Number(windowSize) || STEP_DOT_WINDOW);
  if (totalCount === 0) {
    return { start: 0, end: 0, lead: false, trail: false };
  }
  const current = Math.min(Math.max(0, Number(currentIndex) || 0), totalCount - 1);
  if (totalCount <= size) {
    return { start: 0, end: totalCount, lead: false, trail: false };
  }
  let start = current - Math.floor(size / 2);
  if (start < 0) start = 0;
  if (start + size > totalCount) start = totalCount - size;
  return {
    start,
    end: start + size,
    lead: start > 0,
    trail: start + size < totalCount,
  };
}

export function stepDotSlots(total, currentIndex, windowSize = STEP_DOT_WINDOW) {
  const win = visibleStepWindow(total, currentIndex, windowSize);
  const slots = Array(windowSize).fill(null);
  const count = win.end - win.start;
  const pad = total <= windowSize ? Math.floor((windowSize - count) / 2) : 0;
  for (let i = 0; i < count; i++) slots[pad + i] = win.start + i;
  return { ...win, slots };
}

export function normalizeProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return {
      current_step: null,
      visited: [],
      test_passed: {},
      test_hash: {},
      completed: {},
      editable: {},
      entered_editable: {},
      updated_at: null,
    };
  }
  return {
    current_step: progress.current_step || null,
    visited: Array.isArray(progress.visited) ? [...progress.visited] : [],
    test_passed: progress.test_passed && typeof progress.test_passed === 'object'
      ? { ...progress.test_passed }
      : {},
    test_hash: progress.test_hash && typeof progress.test_hash === 'object'
      ? { ...progress.test_hash }
      : {},
    completed: progress.completed && typeof progress.completed === 'object'
      ? { ...progress.completed }
      : {},
    editable: progress.editable && typeof progress.editable === 'object'
      ? { ...progress.editable }
      : {},
    entered_editable: progress.entered_editable && typeof progress.entered_editable === 'object'
      ? { ...progress.entered_editable }
      : {},
    updated_at: progress.updated_at || null,
  };
}

export function applyStepAccess(result) {
  if (!result) return;
  state.currentStepAccess = {
    editable: Boolean(result.editable),
    needs_edit: result.needs_edit !== false,
    has_solution: Boolean(result.has_solution),
    complete: Boolean(result.complete),
    commands_allowed: result.commands_allowed === undefined
      ? undefined
      : Boolean(result.commands_allowed),
    generation: result.generation ?? null,
  };
  if (state.editor) {
    state.editor.updateOptions({ readOnly: !state.currentStepAccess.editable });
  }
}

export function stepIndexFromId(tutorial, stepId) {
  if (!tutorial?.steps || !stepId) return -1;
  return tutorial.steps.findIndex(step => step.id === stepId);
}

export function renderProgressStrip(tutorial, progress, { currentStepIndex = 0, onSelectStep = null } = {}) {
  const label = document.getElementById('step-now');
  const prev = document.getElementById('prev-step');
  const next = document.getElementById('next-step');
  const dots = document.getElementById('step-dots');
  const total = tutorial?.steps?.length || 0;
  if (!total) {
    if (label) label.textContent = '';
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    if (dots) dots.replaceChildren();
    return;
  }
  const step = tutorial.steps[currentStepIndex];
  const title = step?.title || step?.id || '';
  if (label) {
    label.replaceChildren();
    const n = document.createElement('b');
    n.textContent = `${currentStepIndex + 1} / ${total}`;
    label.append(n, document.createTextNode(` · ${title}`));
    label.title = `${currentStepIndex + 1} / ${total} · ${title}`;
  }
  if (prev) prev.disabled = currentStepIndex <= 0;
  if (next) next.disabled = currentStepIndex >= total - 1;
  renderStepDots(dots, tutorial, progress, currentStepIndex, onSelectStep);
}

function renderStepDots(host, tutorial, progress, currentStepIndex, onSelectStep) {
  if (!host) return;
  const total = tutorial.steps.length;
  const { slots, lead, trail } = stepDotSlots(total, currentStepIndex);
  const completed = progress?.completed && typeof progress.completed === 'object'
    ? progress.completed
    : {};
  host.replaceChildren();

  const leadMark = document.createElement('span');
  leadMark.className = 'step-dots-ellipsis';
  leadMark.setAttribute('aria-hidden', 'true');
  leadMark.textContent = '…';
  leadMark.classList.toggle('is-off', !lead);
  host.append(leadMark);

  for (const index of slots) {
    const slot = document.createElement('span');
    slot.className = 'step-dot-slot';
    if (index === null) {
      host.append(slot);
      continue;
    }
    const item = tutorial.steps[index];
    const done = Boolean(completed[item.id]);
    const current = index === currentStepIndex;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step-dot';
    if (done) btn.classList.add('complete');
    if (current) btn.classList.add('current');
    const itemTitle = item.title || item.id || '';
    const key = done ? 'tutorial.dotComplete' : 'tutorial.dotIncomplete';
    btn.title = t(key, { n: index + 1, title: itemTitle });
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-current', current ? 'step' : 'false');
    btn.addEventListener('click', () => {
      if (index === currentStepIndex) return;
      onSelectStep?.(index);
    });
    slot.append(btn);
    host.append(slot);
  }

  const trailMark = document.createElement('span');
  trailMark.className = 'step-dots-ellipsis';
  trailMark.setAttribute('aria-hidden', 'true');
  trailMark.textContent = '…';
  trailMark.classList.toggle('is-off', !trail);
  host.append(trailMark);
}
