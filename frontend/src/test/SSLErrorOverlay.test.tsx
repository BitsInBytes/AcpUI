import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SSLErrorOverlay from '../components/Modals/SSLErrorOverlay';

describe('SSLErrorOverlay Component', () => {
  it('renders correctly with hostname', () => {
    const hostname = 'localhost';
    render(<SSLErrorOverlay hostname={hostname} />);
    
    expect(screen.getByText('Connection Blocked')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Proceed to ${hostname}`, 'i'))).toBeInTheDocument();
    
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', `https://${hostname}:3005`);
    expect(link).toHaveAttribute('target', '_blank');
  });
});
