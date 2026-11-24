import fs from 'node:fs/promises';
import path from 'node:path';

const COMPONENT_EXPORTS = [
  ['context_pie.js', 'createContextPie'],
  ['token_usage.js', 'createTokenUsage'],
  ['quota_cards.js', 'createQuotaCards'],
  ['model_and_prompt.js', 'createModelAndPrompt'],
  ['sessions_hub.js', 'createSessionsHub'],
  ['runtime_bar.js', 'createRuntimeBar'],
  ['mastery_hub.js', 'createMasteryHub'],
  ['accounts_hub.js', 'createAccountsHub'],
  ['theme_studio.js', 'createThemeStudio'],
  ['changelog_modal.js', 'createChangelogModal'],
];

const I18N_EXPORTS = [
  'DEFAULT_LANG',
  'SUPPORTED_LANGS',
  'DICT',
  'TRANSLATIONS',
  'HOST_UI_DICTIONARY',
  'normalizeLang',
  'setLanguage',
  'getLanguage',
  'translateWithLang',
  'createTranslator',
  't',
  'applyDomI18n',
];

function stripTopLevelExports(source) {
  return String(source || '').replace(
    /^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm,
    '',
  );
}

function stripAppImportsAndExports(source) {
  return stripTopLevelExports(
    String(source || '').replace(
      /^import\s+(?:\{[\s\S]*?\}|\*\s+as\s+\w+|\w+)\s+from\s+["'][^"']+["'];?\r?\n?/gm,
      '',
    ),
  );
}

/**
 * Compile the modular ES frontend sources into a single classic non-module
 * browser script so AUX_PANE iframes work even when type="module" is blocked
 * by host sandbox, CSP, or proxy gateway constraints.
 */
export async function buildFrontendBundle(frontendDir) {
  const [i18nSrc, appSrc, ...componentSources] = await Promise.all([
    fs.readFile(path.join(frontendDir, 'i18n.js'), 'utf8'),
    fs.readFile(path.join(frontendDir, 'app.js'), 'utf8'),
    ...COMPONENT_EXPORTS.map(([file]) =>
      fs.readFile(path.join(frontendDir, 'components', file), 'utf8'),
    ),
  ]);

  const chunks = [
    '(function () {',
    '  "use strict";',
    '  if (typeof window !== "undefined") { window.__agyBundleExecuted = true; }',
    '  const __mods = {};',
    `  __mods.i18n = (function () {\n${stripTopLevelExports(i18nSrc)}\n    return { ${I18N_EXPORTS.join(', ')} };\n  })();`,
  ];

  COMPONENT_EXPORTS.forEach(([file, exportName], idx) => {
    const key = file.replace(/\.js$/, '');
    const body = stripTopLevelExports(componentSources[idx]);
    chunks.push(
      `  __mods[${JSON.stringify(key)}] = (function () {\n${body}\n    return { ${exportName} };\n  })();`,
    );
  });

  const appBody = stripAppImportsAndExports(appSrc);
  chunks.push(
    `  const {\n` +
      `    applyDomI18n,\n` +
      `    createTranslator,\n` +
      `    normalizeLang,\n` +
      `    setLanguage: setGlobalLanguage,\n` +
      `  } = __mods.i18n;\n` +
      `  const { createContextPie } = __mods.context_pie;\n` +
      `  const { createTokenUsage } = __mods.token_usage;\n` +
      `  const { createQuotaCards } = __mods.quota_cards;\n` +
      `  const { createModelAndPrompt } = __mods.model_and_prompt;\n` +
      `  const { createSessionsHub } = __mods.sessions_hub;\n` +
      `  const { createRuntimeBar } = __mods.runtime_bar;\n` +
      `  const { createMasteryHub } = __mods.mastery_hub;\n` +
      `  const { createAccountsHub } = __mods.accounts_hub;\n` +
      `  const { createThemeStudio } = __mods.theme_studio;\n` +
      `  const { createChangelogModal } = __mods.changelog_modal;\n` +
      `${appBody}\n` +
      `  if (typeof window !== "undefined") { window.__agyMonitorMount = mountMonitorApp; }\n` +
      `})();`,
  );

  return chunks.join('\n\n');
}
