/**
 * The chat lorebook view - one chat's `localLore`.
 *
 * The bot's `globalLore` has its own tab (tab-botlore.ts) with its own write
 * path (`setCharacterToIndex`); this one rides the chat write. Both are the
 * same parameterised view - see lore-view.ts.
 */
import { makeLoreTab } from './lore-view';

export const renderLoreTab = makeLoreTab({
  scope: 'local',
  scopeLabel: '이 챗',
  heading: '이 챗의 로어북 항목',
  emptyLines: [
    '이 챗의 로어북 항목이 없습니다. 대부분의 챗은 비어 있는 것이 정상입니다.',
    '봇 전체 로어북은 “봇 로어북” 탭에서 다룹니다.',
  ],
  savedNotice: '저장했습니다. 위 “반영”을 누르면 턴·장기기억과 함께 RisuAI에 쓰입니다.',
});
