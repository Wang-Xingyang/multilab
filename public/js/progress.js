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

export function renderProgressStrip(tutorial, progress, { currentStepIndex = 0, onSelectStep } = {}) {
  const strip = document.getElementById('progress-strip');
  if (!strip) return;
  if (!tutorial?.steps?.length) {
    strip.innerHTML = '';
    return;
  }
  const visited = new Set(progress?.visited || []);
  const passed = progress?.test_passed || {};
  strip.innerHTML = '';
  tutorial.steps.forEach((step, index) => {
    const item = document.createElement('div');
    const isCurrent = index === currentStepIndex;
    const testState = passed[step.id];
    let cls = 'progress-item';
    if (testState === true) cls += ' passed';
    else if (testState === false) cls += ' failed';
    else if (visited.has(step.id)) cls += ' visited';
    if (isCurrent) cls += ' current';
    item.className = cls;
    item.innerHTML =
      `<span class="mark"></span>` +
      `<span class="p-idx">${index + 1}.</span>` +
      `<span class="p-title"></span>`;
    item.querySelector('.p-title').textContent = step.title || step.id;
    item.title = step.id;
    item.addEventListener('click', () => onSelectStep?.(index));
    strip.appendChild(item);
  });
}
