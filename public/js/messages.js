/**
 * Frontend copy catalog.
 * Use t('group.key', { name: 'x' }) so UI strings stay out of feature modules.
 */

const catalog = {
  boot: {
    monacoMissing: '编辑器加载器未就绪。请硬刷新页面；若仍失败请检查 /vendor/monaco-editor 是否可访问',
    monacoTimeout: '编辑器加载超时。教程已加载，可阅读；编辑器可硬刷新后重试',
    monacoFailed: '编辑器加载失败。教程已加载，可阅读；编辑器可硬刷新后重试',
    bootFailed: '前端启动失败: {error}',
    f12Hint: '按 F12 打开开发者工具查看 Console / Network。',
  },
  trust: {
    unloaded: '未加载',
    title: '当前 package trust 状态',
    trusted: '已信任',
    untrusted: '未信任',
    titleWithState: '{source} trust: {trust}',
    sourceDefault: '默认',
    sourceUser: '用户设置',
    confirmGrantTitle: '确认信任此教程包？',
    confirmGrantBody: '信任表示你接受运行该包声明的命令。MultiLab 仍会按 security / sandbox / network 策略限制执行。不要信任来源不明的包。',
    confirmGrantAction: '确认信任',
    confirmRevokeTitle: '取消信任此教程包？',
    confirmRevokeBody: '取消后该包将回到未信任状态。需要 sandbox 的命令仍可按策略运行，但不会享受“用户信任”标记。',
    confirmRevokeAction: '取消信任',
    updateFailed: '更新 trust 失败: {error}',
    markedTrusted: '已标记为信任',
    markedUntrusted: '已标记为未信任',
    logGranted: '已确认信任当前包',
    logRevoked: '已取消信任当前包',
  },
  kernel: {
    none: '无可用 kernel',
    noneCompatible: '无兼容 kernel',
    switching: '切换 kernel...',
    switched: '已切换到 {id}',
    applied: '已应用 {id}',
    switchFailed: '切换 kernel 失败: {error}',
    titleFallback: '当前教程可用 kernel',
  },
  ws: {
    connected: '已连接',
    ready: '终端就绪',
    runtimeReplaced: 'Runtime 已切换，正在重连终端…',
    disconnected: '连接断开,3 秒后重连',
    reconnecting: '正在重连终端',
    reconnectBanner: '[终端重连: {reason}]',
    processExit: '[进程退出, code={code}]',
    errorBanner: '[错误] {error}',
    xtermMissing: '终端库未加载，请检查 /vendor/xterm',
  },
  package: {
    pickMlab: '请选择 .mlab 文件',
    opening: '打开 .mlab...',
    opened: '已打开 .mlab',
    openFailed: '打开失败: {error}',
    libraryOpened: '已打开 {id}@{version}',
    deleted: '已删除教程包',
    deleteFailed: '删除失败: {error}',
    deleteConfirm: '删除已导入包 {id}@{version}？\n digest: {digest}\n\n学员进度不会一并删除。',
    emptyLibrary: '教程库为空。可用「打开 .mlab」导入。',
    loadLibraryFailed: '加载失败: {error}',
    library: '教程库',
    openMlab: '打开 .mlab',
  },
  save: {
    exporting: '导出进度...',
    exported: '已下载进度包',
    exportFailed: '导出进度失败: {error}',
    pickSave: '请选择 .mlab-save 文件',
    importing: '导入进度...',
    imported: '已导入进度',
    importLog: '已导入进度包',
    packageMissing: '缺少对应教程包，请先打开原 .mlab: {error}',
    importFailed: '导入进度失败: {error}',
    saved: '已保存当前 step',
    saveFailed: '保存失败: {error}',
    resetConfirm: '重置当前 step "{title}"？当前 step 的保存会恢复为教程初始状态。',
    resetDone: '已重置当前 step',
    resetFailed: '重置失败: {error}',
    resetLog: '已重置 step {id}',
    exportProgress: '导出进度',
    importProgress: '导入进度',
  },
  tutorial: {
    openLog: '打开教程 {id}',
    loadFailed: '加载教程失败: {error}',
    loadFailedHtml: '加载教程失败: {error}',
    loadFailedHint: '按 F12 打开开发者工具查看详细错误',
    loadingStep: '加载 step...',
    enterLog: '进入 step {id}',
    inherited: '继承 {source} 的保存',
    stepLoaded: 'step 已加载',
    switchFailed: '切换 step 失败: {error}',
    emptyStep: '未加载教程或步骤为空',
    stepInfo: '步骤 {current} / {total} — {title}',
    selectPlaceholder: '未找到教程',
    invalidData: '无效的教程数据',
    stepsSuffix: '步',
    open: '打开',
    delete: '删除',
    prev: '上一步',
    next: '下一步',
    placeholderLoadingTitle: '正在加载教程',
    placeholderLoadingSub: 'MultiLab 正在读取本地教程目录与已导入的包。',
    emptyTitle: '未找到教程',
    emptySub: 'TUTORIALS_DIR 环境变量指向的目录中无可用教程。',
    emptySearchPath: '搜索路径: {dir}',
    emptyCheckTitle: '请确认:',
    emptyCheck1: '教程目录存在且包含 multilab.json',
    emptyCheck2: '.env 中 TUTORIALS_DIR 指向正确',
    listFailedTitle: '加载教程列表失败',
    listFailedHint: '请确认后端服务运行在 http://localhost:{port}',
    backendHint: '请确认后端服务运行在 http://localhost:{port}',
  },
  files: {
    badName: '文件名不能包含路径',
    openFailed: '打开文件失败: {error}',
    emptyWorkspace: '工作区为空',
    loading: '加载中...',
    emptyEditor: '// No files for this step\n',
    loadingEditor: '// Loading tutorial...',
    closeTab: '关闭',
    newFilePrompt: '文件名 (含后缀,如 hello.c)',
    newFileDefault: 'new.c',
    readFailed: '读取失败',
    readDirFailed: '读取目录失败',
    collapseTree: '收起文件树',
    expandTree: '显示文件树',
  },
  commands: {
    wsDisconnected: 'WebSocket 未连接',
    saveBeforeRunFailed: '运行前保存失败: {error}',
    noRunCommand: '当前 step 没有可运行的 command',
    testPassed: '检查通过',
    testFailed: '检查未通过',
    testPassedLog: '检查通过 ({id})',
    testFailedLog: '检查未通过 ({id})',
    testError: '检查失败: {error}',
    previewInteractiveHint: '已在终端启动预览命令。若脚本输出 MULTILAB_PREVIEW_HTML / MULTILAB_PREVIEW_URL，请改用 captured preview。',
    previewStarted: '已启动预览命令',
    previewing: '预览中...',
    previewUpdated: '预览已更新',
    previewCommandFailed: '预览命令失败',
    previewFailed: '预览失败: {error}',
  },
  preview: {
    mappedNote: '本机映射预览',
    mappedFrom: '容器宣告 {url} → 本机映射',
    unmapped: 'Preview URL 尚未映射到本机端口。请使用带 publish_ports 的网络 kernel（如 gcc-ubuntu24-docker-net），并声明 security.network_required 或 security.preview_ports。',
    empty: '(empty preview output)',
    noOutput: '(no output)',
  },
  panels: {
    logsEmpty: '会话日志会显示在这里。',
    diagnosticsLoading: '加载诊断...',
  },
  diagnostics: {
    openTutorial: '打开教程后可查看诊断信息。',
  },
};

export function t(path, vars = {}) {
  const value = path.split('.').reduce((acc, key) => (
    acc && typeof acc === 'object' ? acc[key] : undefined
  ), catalog);
  if (typeof value !== 'string') {
    console.warn(`[messages] missing key: ${path}`);
    return path;
  }
  return value.replace(/\{(\w+)\}/g, (_, key) => (
    vars[key] == null ? '' : String(vars[key])
  ));
}

export function getCatalog() {
  return catalog;
}
