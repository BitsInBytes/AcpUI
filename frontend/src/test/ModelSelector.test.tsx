import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ModelSelector from '../components/ChatInput/ModelSelector';
import { useSystemStore } from '../store/useSystemStore';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const QUICK_ACCESS = [
  { id: 'test-flagship', displayName: 'Flagship', description: 'Best quality' },
  { id: 'test-balanced', displayName: 'Balanced', description: 'Everyday work' },
];

const mockSession = {
  id: 'session-1',
  acpSessionId: 'acp-1',
  name: 'Test Session',
  messages: [],
  model: 'test-balanced',
  currentModelId: 'test-balanced',
  modelOptions: [
    { id: 'test-flagship', name: 'Flagship' },
    { id: 'test-balanced', name: 'Balanced' },
  ],
  isTyping: false,
  isWarmingUp: false,
} as any;

const modelDropdownRef = { current: null } as React.RefObject<HTMLDivElement | null>;

function defaultProps(overrides = {}) {
  return {
    activeSession: mockSession,
    isModelDropdownOpen: false,
    setIsModelDropdownOpen: vi.fn(),
    onModelSelect: vi.fn(),
    modelDropdownRef,
    getActiveModelQuotaPercent: () => null,
    disabled: false,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ModelSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({
        branding: {
          ...useSystemStore.getState().branding,
          models: {
            default: 'test-balanced',
            quickAccess: QUICK_ACCESS,
          },
        },
        contextUsageBySession: {},
        compactingBySession: {},
      });
    });
  });

  // ── Null render ──

  it('returns null when activeSession is undefined', () => {
    const { container } = render(
      <ModelSelector {...defaultProps({ activeSession: undefined })} />
    );
    expect(container.firstChild).toBeNull();
  });

  // ── Label ──

  it('renders "Using" prefix and the current model name', () => {
    render(<ModelSelector {...defaultProps()} />);
    expect(screen.getByText('Using')).toBeInTheDocument();
    // currentModelId = 'test-balanced' → label = 'Balanced'
    expect(screen.getByText('Balanced')).toBeInTheDocument();
  });

  it('shows context percentage appended to model name when available', () => {
    act(() => {
      useSystemStore.setState({ contextUsageBySession: { 'acp-1': 42 } });
    });
    render(<ModelSelector {...defaultProps()} />);
    expect(screen.getByText(/Balanced \(42%\)/)).toBeInTheDocument();
  });

  it('rounds fractional context percentages', () => {
    act(() => {
      useSystemStore.setState({ contextUsageBySession: { 'acp-1': 67.8 } });
    });
    render(<ModelSelector {...defaultProps()} />);
    expect(screen.getByText(/68%/)).toBeInTheDocument();
  });

  it('shows "Compacting..." suffix when isCompacting is true', () => {
    act(() => {
      useSystemStore.setState({ compactingBySession: { 'acp-1': true } });
    });
    render(<ModelSelector {...defaultProps()} />);
    expect(screen.getByText(/Compacting\.\.\./)).toBeInTheDocument();
  });

  it('does not show percentage or compacting when session has no acpSessionId', () => {
    const session = { ...mockSession, acpSessionId: null };
    act(() => {
      useSystemStore.setState({
        contextUsageBySession: { 'acp-1': 50 },
        compactingBySession: { 'acp-1': true },
      });
    });
    render(<ModelSelector {...defaultProps({ activeSession: session })} />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Compacting/)).not.toBeInTheDocument();
  });

  // ── Button state ──

  it('model button is disabled when disabled prop is true', () => {
    render(<ModelSelector {...defaultProps({ disabled: true })} />);
    const btn = screen.getByRole('button', { name: /Balanced/ });
    expect(btn).toBeDisabled();
  });

  it('model button has "static" class and is disabled when quickAccess is empty', () => {
    act(() => {
      useSystemStore.setState({
        branding: {
          ...useSystemStore.getState().branding,
          models: { default: 'test-balanced', quickAccess: [] },
        },
      });
    });
    render(<ModelSelector {...defaultProps()} />);
    const btn = screen.getByRole('button', { name: /Balanced/ });
    expect(btn).toHaveClass('static');
    expect(btn).toBeDisabled();
  });

  // ── Dropdown toggle ──

  it('calls setIsModelDropdownOpen(true) when button is clicked with quickAccess models', () => {
    const setIsModelDropdownOpen = vi.fn();
    render(<ModelSelector {...defaultProps({ setIsModelDropdownOpen })} />);
    fireEvent.click(screen.getByText('Balanced'));
    expect(setIsModelDropdownOpen).toHaveBeenCalledWith(true);
  });

  it('does not open dropdown when disabled=true, even with quickAccess models', () => {
    const setIsModelDropdownOpen = vi.fn();
    render(
      <ModelSelector {...defaultProps({ disabled: true, setIsModelDropdownOpen })} />
    );
    fireEvent.click(screen.getByText('Balanced'));
    expect(setIsModelDropdownOpen).not.toHaveBeenCalled();
  });

  it('does not open dropdown when quickAccess is empty', () => {
    act(() => {
      useSystemStore.setState({
        branding: {
          ...useSystemStore.getState().branding,
          models: { default: 'test-balanced', quickAccess: [] },
        },
      });
    });
    const setIsModelDropdownOpen = vi.fn();
    render(<ModelSelector {...defaultProps({ setIsModelDropdownOpen })} />);
    fireEvent.click(screen.getByText('Balanced'));
    expect(setIsModelDropdownOpen).not.toHaveBeenCalled();
  });

  // ── Dropdown content ──

  it('renders dropdown items when isModelDropdownOpen is true', () => {
    render(<ModelSelector {...defaultProps({ isModelDropdownOpen: true })} />);
    expect(screen.getByText('Flagship')).toBeInTheDocument();
    // "Balanced" appears both in the label and in the dropdown — verify via class
    const itemNames = document.querySelectorAll('.model-dropdown-item-name');
    expect(itemNames.length).toBeGreaterThanOrEqual(2);
  });

  it('renders item descriptions in the dropdown', () => {
    render(<ModelSelector {...defaultProps({ isModelDropdownOpen: true })} />);
    expect(screen.getByText('Best quality')).toBeInTheDocument();
    expect(screen.getByText('Everyday work')).toBeInTheDocument();
  });

  it('omits description span when a choice has no description', () => {
    act(() => {
      useSystemStore.setState({
        branding: {
          ...useSystemStore.getState().branding,
          models: {
            default: 'test-balanced',
            quickAccess: [{ id: 'test-flagship', displayName: 'Flagship' }],
          },
        },
      });
    });
    render(<ModelSelector {...defaultProps({ isModelDropdownOpen: true })} />);
    expect(document.querySelectorAll('.model-dropdown-item-desc')).toHaveLength(0);
  });

  it('marks the currently active model choice with the "active" class', () => {
    // currentModelId = 'test-balanced'
    render(<ModelSelector {...defaultProps({ isModelDropdownOpen: true })} />);
    const items = document.querySelectorAll('.model-dropdown-item');
    const balancedItem = Array.from(items).find(el =>
      el.querySelector('.model-dropdown-item-name')?.textContent === 'Balanced'
    );
    expect(balancedItem).toHaveClass('active');
    const flagshipItem = Array.from(items).find(el =>
      el.querySelector('.model-dropdown-item-name')?.textContent === 'Flagship'
    );
    expect(flagshipItem).not.toHaveClass('active');
  });

  // ── Model selection ──

  it('calls onModelSelect with the choice selection when a dropdown item is clicked', () => {
    const onModelSelect = vi.fn();
    render(
      <ModelSelector
        {...defaultProps({ isModelDropdownOpen: true, onModelSelect })}
      />
    );
    const flagshipItem = Array.from(
      document.querySelectorAll('.model-dropdown-item')
    ).find(el => el.textContent?.includes('Flagship'))!;
    fireEvent.click(flagshipItem);
    expect(onModelSelect).toHaveBeenCalledWith('test-flagship');
  });

  it('calls setIsModelDropdownOpen(false) when a dropdown item is clicked', () => {
    const setIsModelDropdownOpen = vi.fn();
    render(
      <ModelSelector
        {...defaultProps({ isModelDropdownOpen: true, setIsModelDropdownOpen })}
      />
    );
    const flagshipItem = Array.from(
      document.querySelectorAll('.model-dropdown-item')
    ).find(el => el.textContent?.includes('Flagship'))!;
    fireEvent.click(flagshipItem);
    expect(setIsModelDropdownOpen).toHaveBeenCalledWith(false);
  });

  // ── Settings button ──

  it('renders the settings button when onOpenSettings is provided', () => {
    render(<ModelSelector {...defaultProps({ onOpenSettings: vi.fn() })} />);
    expect(screen.getByTitle('Open chat config')).toBeInTheDocument();
  });

  it('does not render the settings button when onOpenSettings is not provided', () => {
    render(<ModelSelector {...defaultProps()} />);
    expect(screen.queryByTitle('Open chat config')).not.toBeInTheDocument();
  });

  it('calls onOpenSettings when the settings button is clicked', () => {
    const onOpenSettings = vi.fn();
    render(<ModelSelector {...defaultProps({ onOpenSettings })} />);
    fireEvent.click(screen.getByTitle('Open chat config'));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
