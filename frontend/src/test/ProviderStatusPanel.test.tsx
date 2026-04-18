import { render, screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import ProviderStatusPanel from '../components/ProviderStatusPanel';
import { useSystemStore } from '../store/useSystemStore';
import type { ProviderStatus } from '../types';

describe('ProviderStatusPanel', () => {
  beforeEach(() => {
    act(() => {
      useSystemStore.setState({ providerStatus: null });
    });
  });

  it('renders nothing when no provider status is available', () => {
    const { container } = render(<ProviderStatusPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders compact summary rows and opens full details in a modal', () => {
    const status: ProviderStatus = {
      providerId: 'provider-id',
      title: 'Provider',
      subtitle: 'Workspace',
      updatedAt: '2026-04-18T18:23:14.941Z',
      summary: {
        title: 'Summary',
        items: [
          { id: 'metric-a', label: 'Metric A', value: '42 units', tone: 'info', progress: { value: 0.42 } },
        ],
      },
      sections: [
        {
          id: 'details',
          title: 'All Metrics',
          items: [
            { id: 'metric-a', label: 'Metric A', value: '42 units', detail: 'Full detail', tone: 'info', progress: { value: 0.42 } },
            { id: 'metric-b', label: 'Metric B', value: '$1.23', detail: 'Secondary detail' },
          ],
        },
      ],
    };
    act(() => {
      useSystemStore.getState().setProviderStatus(status);
    });

    const { container } = render(<ProviderStatusPanel />);

    expect(screen.getByLabelText('Provider status')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('Metric A')).toBeInTheDocument();
    expect(screen.getByText('42 units')).toBeInTheDocument();
    expect(screen.queryByText('Full detail')).not.toBeInTheDocument();
    expect(container.querySelector('.provider-status-progress-fill')).toHaveStyle({ width: '42%' });

    fireEvent.click(screen.getByTitle('Provider status details'));

    expect(screen.getByRole('dialog', { name: 'Provider status details' })).toBeInTheDocument();
    expect(screen.getByText('All Metrics')).toBeInTheDocument();
    expect(screen.getByText('Full detail')).toBeInTheDocument();
    expect(screen.getByText('Secondary detail')).toBeInTheDocument();
  });

  it('falls back to the first two section items when no summary is provided', () => {
    act(() => {
      useSystemStore.getState().setProviderStatus({
        providerId: 'provider-id',
        title: 'Provider',
        sections: [{
          id: 'section',
          items: [
            { id: 'first', label: 'First', value: '1' },
            { id: 'second', label: 'Second', value: '2' },
            { id: 'third', label: 'Third', value: '3' },
          ],
        }],
      });
    });

    render(<ProviderStatusPanel />);

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('Third')).not.toBeInTheDocument();
  });

  it('renders compact summary detail text below progress rows', () => {
    act(() => {
      useSystemStore.getState().setProviderStatus({
        providerId: 'provider-id',
        title: 'Provider',
        summary: {
          items: [
            { id: 'usage', label: 'Usage', value: '42%', detail: 'Resets Apr 25, 10:50 PM', progress: { value: 0.42 } },
          ],
        },
        sections: [{
          id: 'section',
          items: [{ id: 'usage', label: 'Usage', value: '42%', detail: 'Resets Apr 25, 10:50 PM', progress: { value: 0.42 } }],
        }],
      });
    });

    render(<ProviderStatusPanel />);

    expect(screen.getByText('Resets Apr 25, 10:50 PM')).toBeInTheDocument();
  });

  it('clamps progress bars to the normalized 0 to 1 range', () => {
    act(() => {
      useSystemStore.getState().setProviderStatus({
        providerId: 'provider-id',
        title: 'Provider',
        summary: {
          items: [
            { id: 'low', label: 'Low', progress: { value: -1 } },
            { id: 'high', label: 'High', progress: { value: 2 } },
          ],
        },
        sections: [{
          id: 'section',
          items: [{ id: 'low', label: 'Low', progress: { value: -1 } }],
        }],
      });
    });

    const { container } = render(<ProviderStatusPanel />);
    const fills = container.querySelectorAll('.provider-status-progress-fill');

    expect(fills[0]).toHaveStyle({ width: '0%' });
    expect(fills[1]).toHaveStyle({ width: '100%' });
  });
});
