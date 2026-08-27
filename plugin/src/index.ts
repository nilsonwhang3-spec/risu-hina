/**
 * Risu Hina - RisuAI chat post-editing.
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
 * Config lives in pluginStorage and nowhere else.
 *
 * There used to be `//@arg backend_url` / `backend_token` fields on RisuAI's
 * plugin screen as well. RisuAI wipes them on every plugin update, so after
 * each `+` the user saw two empty boxes that looked like something they had
 * to fill in again - while the real values sat untouched in
 * `db.pluginCustomStorage`. The fields are gone; ⚙ → 연결 is the one place.
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
  return { url: url || DEFAULT_URL, token };
}

(async () => {
  'use strict';

  const parts: { id: string }[] = [];

  try {
    transport.configure(await resolveConfig());
  } catch (e) {
    console.log('[risu-hina] config resolve failed', e);
  }

  const open = async () => {
    try {
      // showContainer first, then paint: revealing an empty panel immediately
      // reads as "opening", while doing the work first reads as "hung".
      await Risuai.showContainer('fullscreen');
      await bootstrap();
    } catch (e) {
      console.log('[risu-hina] open failed', e);
    }
  };

  try {
    parts.push(await Risuai.registerSetting('Risu Hina', open, ICON.app, 'html'));
  } catch (e) {
    console.log('[risu-hina] registerSetting failed', e);
  }
  try {
    parts.push(await Risuai.registerButton(
      { name: 'Risu Hina', icon: ICON.app, iconType: 'html', location: 'hamburger' },
      open,
    ));
  } catch (e) {
    console.log('[risu-hina] registerButton failed', e);
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

  console.log(`[risu-hina] v${__PLUGIN_VERSION__} loaded`);
})();
