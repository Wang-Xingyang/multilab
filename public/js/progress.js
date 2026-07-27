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
  const container = document.getElementById('step-dots');
  if (!container) return;
  if (!tutorial?.steps?.length) {
    container.innerHTML = '';
    return;
  }
  const visited = new Set(progress?.visited || []);
  const passed = progress?.test_passed || {};
  const total = tutorial.steps.length;
  container.innerHTML = '';
  tutorial.steps.forEach((step, index) => {
    const isCurrent = index === currentStepIndex;
    const testState = passed[step.id];
    let cls = 'step-dot';
    if (testState === true) cls += ' passed';
    else if (testState === false) cls += ' failed';
    else if (visited.has(step.id)) cls += ' visited';
    if (isCurrent) cls += ' current';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    const title = step.title || step.id;
    btn.title = `${index + 1}. ${title}`;
    if (isCurrent) {
      btn.innerHTML =
        `<span class="dot"></span>` +
        `<span class="idx">${index + 1}/${total}</span>` +
        `<span class="label"></span>`;
      btn.querySelector('.label').textContent = title;
    } else {
      btn.innerHTML = `<span class="dot"></span>`;
    }
    btn.addEventListener('click', () => onSelectStep?.(index));
    container.appendChild(btn);
  });
  const prev = document.getElementById('prev-step');
  const next = document.getElementById('next-step');
  if (prev) prev.disabled = currentStepIndex <= 0;
  if (next) next.disabled = currentStepIndex >= total - 1;
}
