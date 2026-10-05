import { defineApplicationRole } from 'twenty-sdk/define';

import { DEFAULT_ROLE_UNIVERSAL_IDENTIFIER } from '../constants/universal-identifiers';

// This app owns no objects and no logic functions — the widget's own CRM
// access happens entirely inside agent-runtime, under the Manager's own
// approval-gated scope, never under this app's role. Required by the
// framework regardless; kept at zero access since nothing here needs any.
export default defineApplicationRole({
  universalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  label: 'Manager Agent default role',
  description: 'Manager Agent default role — no object or logic function access needed.',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  canBeAssignedToAgents: false,
  canBeAssignedToUsers: false,
  canBeAssignedToApiKeys: false,
  objectPermissions: [],
  fieldPermissions: [],
  permissionFlagUniversalIdentifiers: [],
});
