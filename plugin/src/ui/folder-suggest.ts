/**
 * "이 봇의 작업 폴더 이름을 봇 이름에 맞출까요?" (§1-89).
 *
 * A bot's project folder (projects/<폴더>) is named once, the first time
 * anything needs it, and pinned - so a bot that was still unnamed then (a
 * fresh blank card) keeps a folder named by its key, `c` + 16 hex. Renaming
 * that folder by hand in the files tab is the wrong fix: notes, asset rules
 * and studio output are keyed by the folder name, and the pin would bring an
 * empty old-named folder straight back. The backend's project rename moves
 * all of it; this module is the one place that offers it.
 *
 * Asked after an open and after a card 반영 (the moment a name usually gets
 * decided). "그대로 두기" is remembered per bot and suggested name, so the
 * same question does not come back on every open; a different name later
 * asks again.
 */
import { state } from '../state';
import { shellNotice, shellPrompt } from './chatbar';

const DISMISS_KEY = 'hina.folderSuggestDismissed';

function dismissed(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') as Record<string, string>; } catch { return {}; }
}

function dismiss(charKey: string, name: string): void {
  try {
    const d = dismissed();
    d[charKey] = name;
    localStorage.setItem(DISMISS_KEY, JSON.stringify(d));
  } catch { /* a convenience only */ }
}

let askedFor = '';

export async function suggestFolderRename(): Promise<void> {
  const ck = state.activeCharKey;
  if (!ck || !state.health) return;
  let info: Awaited<ReturnType<typeof state.botFolderInfo>> = null;
  try { info = await state.botFolderInfo(); } catch { return; }
  // Only a placeholder (key-named) folder: one that already carries a name -
  // an earlier name of the bot, or one the user picked - is theirs to keep.
  if (!info || !info.suggested || !info.hashLike || ck !== state.activeCharKey) return;
  if (dismissed()[ck] === info.suggested) return;
  const tag = ck + '\u0000' + info.suggested + '\u0000' + info.folder;
  if (askedFor === tag) return;
  askedFor = tag;
  const why = `이 봇의 작업 폴더가 이름이 정해지기 전에 임시 이름(projects/${info.folder})으로 만들어졌습니다.`;
  shellPrompt(`${why} 봇 이름에 맞춰 projects/${info.suggested} 로 바꿀까요? (폴더 안 파일·AI 메모·에셋 규칙·스튜디오 결과도 함께 옮깁니다)`, [
    {
      label: `${info.suggested} 로 바꾸기`, primary: true,
      run: async () => {
        try {
          const r = await state.renameBotFolder(info!.suggested);
          shellNotice(`작업 폴더를 projects/${r.folder} 로 바꿨습니다.`, 'ok');
        } catch (e) {
          shellNotice('폴더 이름을 바꾸지 못했습니다: ' + (e instanceof Error ? e.message : String(e)), 'err');
        }
      },
    },
    { label: '그대로 두기', run: () => { dismiss(ck, info!.suggested); } },
  ]);
}

// A name decided later - typically a card 반영 that set it, from the bot bar,
// the title-row 반영 or an approved proposal alike - shows up here as the
// re-read workspace carrying a new name for the same bot.
let seenName = '';
state.onChange(() => {
  const ws = state.workspace;
  if (!ws) return;
  const tag = ws.charKey + '\u0000' + (ws.characterName || '');
  if (tag === seenName) return;
  const sameBot = seenName.startsWith(ws.charKey + '\u0000');
  seenName = tag;
  if (sameBot && ws.characterName) void suggestFolderRename();
});
