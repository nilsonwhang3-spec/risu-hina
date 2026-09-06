/**
 * Risu Hina - RisuAI chat post-editing.
 *
 * Entry point: register the UI, resolve config, and get out of the way. The
 * panel is not built until the user opens it, because a plugin that does work
 * on load slows down every RisuAI start whether or not it is used.
 */
import { transport, clientLog } from './transport';
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

  // §1-53: a phone that "keeps resetting" leaves no trace on the server -
  // log how this page load came about (reload / back_forward / navigate),
  // the device, and every uncaught error and page hide, so the server log
  // (⚙ → 정보 · 로그) tells whether the browser reloaded the whole page.
  try {
    const nav = (performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined);
    void clientLog('info', 'plugin boot', {
      navigation: nav?.type ?? '?',
      ua: navigator.userAgent.slice(0, 120),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      memory: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
    });
    window.addEventListener('error', (ev) => {
      void clientLog('error', 'uncaught error', { message: String(ev.message).slice(0, 300), file: String(ev.filename || '').slice(-80), line: ev.lineno });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      void clientLog('error', 'unhandled rejection', { reason: String((ev as PromiseRejectionEvent).reason).slice(0, 300) });
    });
    window.addEventListener('pagehide', (ev) => {
      // sendBeacon-less: the POST may or may not make it; the next boot's
      // navigation type says what happened either way.
      void clientLog('info', 'pagehide', { persisted: (ev as PageTransitionEvent).persisted, visibility: document.visibilityState });
    });
  } catch { /* logging must never break the plugin */ }

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
      // RisuAI reloads every plugin when any one of them is updated or
      // installed (loadPlugins -> loadV3Plugins unloads all instances and
      // starts them again). This is the only trace of that from our side: an
      // open panel simply vanishes, and the next open is a cold start. The
      // line makes "it disconnected after the other plugin's update notice"
      // readable in the server log as a reload, not a network failure.
      void clientLog('info', 'unloaded by host (plugin reload or disable)', {
        platform: transport.hostPlatform, connected: !!transport.health,
      });
      for (const p of parts) {
        if (p?.id) {
          try { await Risuai.unregisterUIPart(p.id); } catch { /* already gone */ }
        }
      }
    });
  } catch { /* optional */ }

  console.log(`[risu-hina] v${__PLUGIN_VERSION__} loaded`);
})();
