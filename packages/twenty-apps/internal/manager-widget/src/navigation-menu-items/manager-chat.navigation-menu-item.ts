import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import {
  MANAGER_CHAT_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  MANAGER_CHAT_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
} from '../constants/universal-identifiers';

// No Assistant/Manager toggle here — that split is Phase 6 (ticket #45 is
// explicit this stays out of scope). Every admin who can see this sidebar
// item can open the page; the real access boundary is the server-side
// Admin check on every request to agent-runtime, not this item's visibility.
export default defineNavigationMenuItem({
  universalIdentifier: MANAGER_CHAT_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Manager Agent',
  icon: 'IconLego',
  color: 'blue',
  position: 50,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  pageLayoutUniversalIdentifier: MANAGER_CHAT_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
});
