import React from 'react';
import type { SlashCommand } from '../../store/useSystemStore';

interface SlashDropdownProps {
  commands: SlashCommand[];
  visible: boolean;
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
}

const SlashDropdown: React.FC<SlashDropdownProps> = ({ commands, visible, selectedIndex, onSelect }) => {
  if (!visible) return null;

  return (
    <div className="slash-dropdown">
      {commands.map((cmd, i) => (
        <div
          key={cmd.name}
          className={`slash-item ${i === selectedIndex ? 'active' : ''}`}
          onMouseDown={() => onSelect(cmd)}
        >
          <span className="slash-name">{cmd.name}</span>
          <span className="slash-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
};

export default SlashDropdown;
