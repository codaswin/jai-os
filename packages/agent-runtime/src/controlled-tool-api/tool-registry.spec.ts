import { TOOL_REGISTRY } from './tool-registry';

describe('TOOL_REGISTRY', () => {
  it('registers no tool whose name or scope references invoices', () => {
    const names = Object.keys(TOOL_REGISTRY);

    for (const name of names) {
      expect(name.toLowerCase()).not.toContain('invoice');
      expect(TOOL_REGISTRY[name].requiredScope.toLowerCase()).not.toContain('invoice');
    }
  });

  it('registers the generic CRM tools with the expected approval gating', () => {
    expect(TOOL_REGISTRY['lookup-crm-record'].requiresApproval).toBeFalsy();
    expect(TOOL_REGISTRY['create-crm-record'].requiresApproval).toBe(true);
    expect(TOOL_REGISTRY['update-crm-record'].requiresApproval).toBe(true);
  });
});
