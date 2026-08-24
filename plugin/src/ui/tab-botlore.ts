/**
 * The bot lorebook view - the character's `globalLore`.
 *
 * Every chat of this bot sees these entries, which is why they are edited on
 * a tab whose bar writes through `setCharacterToIndex` (the bot bar), not on
 * the chat tabs. Same parameterised view as the chat lorebook - lore-view.ts.
 */
import { makeLoreTab } from './lore-view';

export const renderBotLoreTab = makeLoreTab({
  scope: 'global',
  scopeLabel: '이 봇',
  heading: '봇 로어북 항목',
  emptyLines: [
    '이 봇의 로어북(globalLore)이 비어 있습니다.',
    '여기 항목은 이 봇의 모든 챗에 적용됩니다.',
  ],
  savedNotice: '저장했습니다. 봇 바의 “반영”을 누르면 카드와 함께 RisuAI에 쓰입니다.',
});
