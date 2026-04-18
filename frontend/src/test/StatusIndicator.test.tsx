import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusIndicator from '../components/Status/StatusIndicator';

describe('StatusIndicator', () => {
  it('renders disconnected state', () => {
    render(<StatusIndicator connected={false} isEngineReady={false} />);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('renders warming up state', () => {
    render(<StatusIndicator connected={true} isEngineReady={false} />);
    expect(screen.getByText('Warming up...')).toBeInTheDocument();
  });

  it('renders ready state', () => {
    render(<StatusIndicator connected={true} isEngineReady={true} />);
    expect(screen.getByText('Engine Ready')).toBeInTheDocument();
  });
});
