import { defineApplication } from 'twenty-sdk/define';

export const APPLICATION_UNIVERSAL_IDENTIFIER =
  '52da66e2-ee93-4255-ad3e-17975e9bdd60';

export default defineApplication({
  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
  displayName: 'Manager Agent',
  description:
    'Chat widget for talking to the JAI OS Manager agent from inside Twenty',
});
