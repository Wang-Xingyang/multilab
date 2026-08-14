/**
 * Save archive (.mlab-save) export/import.
 *
 * Depends on tutorial-loader.js (loadTutorialList) + files.js (saveCurrentStep).
 */
import { state, currentTutorialKey } from './state.js';
import { apiPostBlob, uploadArchive } from './api.js';
import { toast, status } from './ui.js';
import { t } from './messages.js';
import { appendSessionLog } from './session-log.js';
import { applyProgress } from './panels.js';
import { saveCurrentStep } from './files.js';
import { handleError } from './errors.js';

export async function exportSaveDownload() {
  if (!state.currentTutorial) return;
  const tutorialKey = currentTutorialKey();
  try {
    await saveCurrentStep({ silent: true, force: true });
    status(t('save.exporting'));
    const { blob, filename } = await apiPostBlob('/api/saves/download', { tutorial: tutorialKey });
    const finalName = filename || `${state.currentTutorial.package_id || 'tutorial'}.mlab-save`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(t('save.exported'));
  } catch (e) {
    handleError(e, {
      feature: 'save',
      message: t('save.exportFailed', { error: e.message }),
      notify: true,
    });
  }
}

export async function importSaveFromFile(file) {
  if (!file) return;
  if (!/\.mlab-save$/i.test(file.name)) {
    toast(t('save.pickSave'), true);
    return;
  }
  try {
    status(t('save.importing'));
    const result = await uploadArchive('/api/saves/upload', file);
    applyProgress(result.progress);
    await loadTutorialListSafe({ preferredKey: result.source_key });
    appendSessionLog(t('save.importLog'));
    toast(t('save.imported'));
  } catch (e) {
    if (e.code === 'package_missing' || /matching package not found/.test(e.message || '')) {
      handleError(e, {
        feature: 'save',
        message: t('save.packageMissing', { error: e.message }),
        notify: true,
      });
      return;
    }
    handleError(e, {
      feature: 'save',
      message: t('save.importFailed', { error: e.message }),
      notify: true,
    });
  }
}

// Local import to keep this module decoupled from tutorial-loader at parse time.
// (loadTutorialList is pulled lazily so the dependency direction stays explicit.)
async function loadTutorialListSafe(opts) {
  const { loadTutorialList } = await import('./tutorial-loader.js');
  return loadTutorialList(opts);
}
