import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInput } from '../src/components/ChatInput.js';
import * as client from '../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client.api, 'getRoster').mockResolvedValue({ roster: [] });
  vi.spyOn(client.api, 'listRepos').mockResolvedValue({ repos: [] });
  vi.spyOn(client.api, 'listWorkflows').mockResolvedValue({ workflows: [] });
});

describe('ChatInput workflow selector (system-workflow filter)', () => {
  it('hides workflows with is_system: true from the ContextPopover dropdown', async () => {
    const user = userEvent.setup();
    vi.mocked(client.api.listWorkflows).mockResolvedValue({
      workflows: [
        { id: 'chat',      is_system: true,  phases: [] },
        { id: 'onboarding', is_system: true, phases: [] },
        { id: 'feature',   is_system: false, phases: [] },
        { id: 'custom-wf',                   phases: [] },
      ],
    });

    render(<ChatInput runId={null} runStatus={null} onLaunched={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /open launch options/i }));

    const select = await screen.findByTestId('launch-workflow');
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);

    expect(values).not.toContain('chat');
    expect(values).not.toContain('onboarding');
    expect(values).toContain('feature');
    expect(values).toContain('custom-wf');
  });
});
