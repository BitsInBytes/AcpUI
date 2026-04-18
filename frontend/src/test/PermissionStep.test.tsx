import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PermissionStep from '../components/PermissionStep';

// Minimal step fixture matching the PermissionTimelineStep shape
function makeStep(overrides = {}) {
  return {
    type: 'permission' as const,
    request: {
      id: 42,
      toolCall: {
        title: 'Do you want to proceed?',
        toolCallId: 'tool-call-abc',
      },
      options: [
        { optionId: 'allow', kind: 'primary', name: 'Allow' },
        { optionId: 'deny',  kind: 'danger',  name: 'Deny'  },
      ],
    },
    response: null,
    ...overrides,
  } as any;
}

describe('PermissionStep', () => {
  let onRespond: (requestId: number, optionId: string, toolCallId?: string) => void;

  beforeEach(() => {
    onRespond = vi.fn<(requestId: number, optionId: string, toolCallId?: string) => void>();
  });

  it('renders the "Permission Requested" header', () => {
    render(<PermissionStep step={makeStep()} onRespond={onRespond} />);
    expect(screen.getByText('Permission Requested')).toBeInTheDocument();
  });

  it('shows the toolCall title as the prompt text', () => {
    render(<PermissionStep step={makeStep()} onRespond={onRespond} />);
    expect(screen.getByText('Do you want to proceed?')).toBeInTheDocument();
  });

  it('falls back to the default message when toolCall is absent', () => {
    const step = makeStep();
    step.request.toolCall = undefined;
    render(<PermissionStep step={step} onRespond={onRespond} />);
    expect(
      screen.getByText('The agent is requesting permission to proceed.')
    ).toBeInTheDocument();
  });

  it('renders one button per option', () => {
    render(<PermissionStep step={makeStep()} onRespond={onRespond} />);
    expect(screen.getByText('Allow')).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
  });

  it('each button has a CSS class matching its opt.kind', () => {
    render(<PermissionStep step={makeStep()} onRespond={onRespond} />);
    expect(screen.getByText('Allow').className).toContain('primary');
    expect(screen.getByText('Deny').className).toContain('danger');
  });

  it('calls onRespond with (requestId, optionId, toolCallId) on click', () => {
    render(<PermissionStep step={makeStep()} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Allow'));
    expect(onRespond).toHaveBeenCalledWith(42, 'allow', 'tool-call-abc');
  });

  it('passes undefined as toolCallId when toolCall is absent', () => {
    const step = makeStep();
    step.request.toolCall = undefined;
    render(<PermissionStep step={step} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Allow'));
    expect(onRespond).toHaveBeenCalledWith(42, 'allow', undefined);
  });

  it('all buttons are disabled once step.response is set', () => {
    render(<PermissionStep step={makeStep({ response: 'Allow' })} onRespond={onRespond} />);
    // Both the button and the confirmation <strong> render "Allow" — use getByRole to target buttons specifically.
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  it('buttons are enabled when step.response is null', () => {
    render(<PermissionStep step={makeStep({ response: null })} onRespond={onRespond} />);
    expect(screen.getByText('Allow')).not.toBeDisabled();
    expect(screen.getByText('Deny')).not.toBeDisabled();
  });

  it('shows the selected option in a confirmation message after response', () => {
    render(<PermissionStep step={makeStep({ response: 'Allow' })} onRespond={onRespond} />);
    expect(screen.getByText(/Selection:/)).toBeInTheDocument();
    expect(screen.getByText('Allow', { selector: 'strong' })).toBeInTheDocument();
  });

  it('does not show a confirmation message when response is null', () => {
    render(<PermissionStep step={makeStep({ response: null })} onRespond={onRespond} />);
    expect(screen.queryByText(/Selection:/)).not.toBeInTheDocument();
  });

  it('renders with multiple options correctly', () => {
    const step = makeStep();
    step.request.options = [
      { optionId: 'yes',    kind: 'primary', name: 'Yes'    },
      { optionId: 'no',     kind: 'danger',  name: 'No'     },
      { optionId: 'maybe',  kind: 'default', name: 'Maybe'  },
    ];
    render(<PermissionStep step={step} onRespond={onRespond} />);
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('Maybe')).toBeInTheDocument();
  });
});
