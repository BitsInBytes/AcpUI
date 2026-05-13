import { render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import ConfigErrorModal from '../components/ConfigErrorModal';
import { useSystemStore } from '../store/useSystemStore';

describe('ConfigErrorModal', () => {
  beforeEach(() => {
    useSystemStore.setState({ invalidJsonConfigs: [] });
  });

  it('renders nothing when there are no invalid JSON configs', () => {
    render(<ConfigErrorModal />);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('renders a blocking alert with every invalid JSON config', () => {
    useSystemStore.setState({
      invalidJsonConfigs: [
        {
          id: 'commands-config',
          label: 'Custom commands configuration',
          path: 'D:/Git/AcpUI/configuration/commands.json',
          message: 'Unexpected token } in JSON at position 4'
        },
        {
          id: 'provider-registry',
          label: 'Provider registry',
          path: 'D:/Git/AcpUI/configuration/providers.json',
          message: 'Unexpected end of JSON input',
          blocksStartup: true
        }
      ]
    });

    render(<ConfigErrorModal />);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Invalid JSON Configuration')).toBeInTheDocument();
    expect(screen.getByText('Custom commands configuration')).toBeInTheDocument();
    expect(screen.getByText('Provider registry')).toBeInTheDocument();
    expect(screen.getByText('D:/Git/AcpUI/configuration/commands.json')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
