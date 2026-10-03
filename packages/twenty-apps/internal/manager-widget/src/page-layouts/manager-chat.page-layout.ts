import { definePageLayout, PageLayoutTabLayoutMode } from 'twenty-sdk/define';

import {
  MANAGER_CHAT_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  MANAGER_CHAT_PAGE_LAYOUT_TAB_UNIVERSAL_IDENTIFIER,
  MANAGER_CHAT_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
  MANAGER_CHAT_PAGE_LAYOUT_WIDGET_UNIVERSAL_IDENTIFIER,
} from '../constants/universal-identifiers';

export default definePageLayout({
  universalIdentifier: MANAGER_CHAT_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
  name: 'Manager Agent',
  type: 'STANDALONE_PAGE',
  tabs: [
    {
      universalIdentifier: MANAGER_CHAT_PAGE_LAYOUT_TAB_UNIVERSAL_IDENTIFIER,
      title: 'Manager Agent',
      position: 0,
      icon: 'IconLego',
      layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
      widgets: [
        {
          universalIdentifier: MANAGER_CHAT_PAGE_LAYOUT_WIDGET_UNIVERSAL_IDENTIFIER,
          title: 'Manager Agent',
          type: 'FRONT_COMPONENT',
          // No separate "fill the tab" flag in this SDK version — a
          // VERTICAL_LIST tab's single widget already fills the viewport.
          position: { layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST, index: 0 },
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier: MANAGER_CHAT_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
          },
        },
      ],
    },
  ],
});
