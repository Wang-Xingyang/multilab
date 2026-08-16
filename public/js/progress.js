export function normalizeProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return { current_step: null, visited: [], test_passed: {}, updated_at: null };
  }
  return {
    current_step: progress.current_step || null,
    visited: Array.isArray(progress.visited) ? [...progress.visited] : [],
    test_passed: progress.test_passed && typeof progress.test_passed === 'object'
      ? { ...progress.test_passed }
      : {},
    updated_at: progress.updated_at || null,
  };
}

export function stepIndexFromId(tutorial, stepId) {
  if (!tutorial?.steps || !stepId) return -1;
  return tutorial.steps.findIndex(step => step.id === stepId);
}

export function renderProgressStrip(tutorial, progress, { currentStepIndex = 0 } = {}) {
  const label = document.getElementById('step-now');
  const prev = document.getElementById('prev-step');
  const next = document.getElementById('next-step');
  const total = tutorial?.steps?.length || 0;
  if (!total) {
    if (label) label.textContent = '';
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
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
}
