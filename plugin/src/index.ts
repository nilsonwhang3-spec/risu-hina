/**
 * Risu Elf - RisuAI chat post-editing.
 *
 * Entry point: register the UI, resolve config, and get out of the way. The
 * panel is not built until the user opens it, because a plugin that does work
 * on load slows down every RisuAI start whether or not it is used.
 */
import { transport } from './transport';
import { bootstrap } from './ui/shell';
import { ICON } from './ui/dom';

const DEFAULT_URL = 'http://127.0.0.1:6020';

/**
 * Config lives in two places and pluginStorage wins.
 *
 * `//@arg` values are wiped when the plugin is reinstalled, which during
 * development is every few minutes; `db.pluginCustomStorage` survives. Args are
 * still read so a first-time user can fill them in the normal RisuAI way.
 */
async function resolveConfig(): Promise<{ url: string; token: string }> {
  let url = '';
  let token = '';
  try {
    const stored = await Risuai.pluginStorage.getItem('backend');
    if (stored && typeof stored === 'object') {
      url = String((stored as Record<string, unknown>).url ?? '');
      token = String((stored as Record<string, unknown>).token ?? '');
    }
  } catch { /* first run */ }

  if (!url) {
    try { url = String((await Risuai.getArgument('backend_url')) ?? '').trim(); } catch { /* ignore */ }
  }
  if (!token) {
    try { token = String((await Risuai.getArgument('backend_token')) ?? '').trim(); } catch { /* ignore */ }
  }
  return { url: url || DEFAULT_URL, token };
}

(async () => {
  'use strict';

  const parts: { id: string }[] = [];

  try {
    transport.configure(await resolveConfig());
  } catch (e) {
    console.log('[risu-elf] config resolve failed', e);
  }

  const open = async () => {
    try {
      // showContainer first, then paint: revealing an empty panel immediately
      // reads as "opening", while doing the work first reads as "hung".
      await Risuai.showContainer('fullscreen');
      await bootstrap();
    } catch (e) {
      console.log('[risu-elf] open failed', e);
    }
  };

  try {
    parts.push(await Risuai.registerSetting('Risu Elf', open, ICON.app, 'html'));
  } catch (e) {
    console.log('[risu-elf] registerSetting failed', e);
  }
  try {
    parts.push(await Risuai.registerButton(
      { name: 'Risu Elf', icon: ICON.app, iconType: 'html', location: 'hamburger' },
      open,
    ));
  } catch (e) {
    console.log('[risu-elf] registerButton failed', e);
  }

  try {
    await Risuai.onUnload(async () => {
      for (const p of parts) {
        if (p?.id) {
          try { await Risuai.unregisterUIPart(p.id); } catch { /* already gone */ }
        }
      }
    });
  } catch { /* optional */ }

  console.log(`[risu-elf] v${__PLUGIN_VERSION__} loaded`);
})();
