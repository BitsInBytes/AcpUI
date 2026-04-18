import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SlashDropdown from '../components/ChatInput/SlashDropdown';
import type { SlashCommand } from '../store/useSystemStore';

const commands: SlashCommand[] = [
  { name: '/save',     description: 'Save session',  meta: {} },
  { name: '/settings', description: 'Open settings', meta: {} },
  { name: '/context',  description: 'Add context',   meta: { hint: 'path' } },
];

describe('SlashDropdown', () => {
  it('returns null when visible is false', () => {
    const { container } = render(
      <SlashDropdown
        commands={commands}
        visible={false}
        selectedIndex={0}
        onSelect={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the dropdown container when visible is true', () => {
    const { container } = render(
      <SlashDropdown
        commands={commands}
        visible={true}
        selectedIndex={0}
        onSelect={vi.fn()}
      />
    );
    expect(container.querySelector('.slash-dropdown')).toBeInTheDocument();
  });

  it('renders all command names', () => {
    render(
      <SlashDropdown commands={commands} visible={true} selectedIndex={0} onSelect={vi.fn()} />
    );
    expect(screen.getByText('/save')).toBeInTheDocument();
    expect(screen.getByText('/settings')).toBeInTheDocument();
    expect(screen.getByText('/context')).toBeInTheDocument();
  });

  it('renders all command descriptions', () => {
    render(
      <SlashDropdown commands={commands} visible={true} selectedIndex={0} onSelect={vi.fn()} />
    );
    expect(screen.getByText('Save session')).toBeInTheDocument();
    expect(screen.getByText('Open settings')).toBeInTheDocument();
    expect(screen.getByText('Add context')).toBeInTheDocument();
  });

  it('applies the "active" class only to the item at selectedIndex', () => {
    render(
      <SlashDropdown commands={commands} visible={true} selectedIndex={1} onSelect={vi.fn()} />
    );
    const items = document.querySelectorAll('.slash-item');
    expect(items[0]).not.toHaveClass('active');
    expect(items[1]).toHaveClass('active');
    expect(items[2]).not.toHaveClass('active');
  });

  it('applies the "active" class to the first item when selectedIndex is 0', () => {
    render(
      <SlashDropdown commands={commands} visible={true} selectedIndex={0} onSelect={vi.fn()} />
    );
    const items = document.querySelectorAll('.slash-item');
    expect(items[0]).toHaveClass('active');
    expect(items[1]).not.toHaveClass('active');
  });

  it('calls onSelect with the correct command on mouseDown', () => {
    const onSelect = vi.fn();
    render(
      <SlashDropdown commands={commands} visible={true} selectedIndex={0} onSelect={onSelect} />
    );
    fireEvent.mouseDown(screen.getByText('/settings').closest('.slash-item')!);
    expect(onSelect).toHaveBeenCalledWith(commands[1]);
  });

  it('calls onSelect with the first command when the first item is clicked', () => {
    const onSelect = vi.fn();
    render(
      <SlashDropdown commands={commands} visible={true} selectedIndex={0} onSelect={onSelect} />
    );
    fireEvent.mouseDown(screen.getByText('/save').closest('.slash-item')!);
    expect(onSelect).toHaveBeenCalledWith(commands[0]);
  });

  it('renders an empty dropdown (no items) when commands array is empty', () => {
    const { container } = render(
      <SlashDropdown commands={[]} visible={true} selectedIndex={0} onSelect={vi.fn()} />
    );
    expect(container.querySelector('.slash-dropdown')).toBeInTheDocument();
    expect(container.querySelectorAll('.slash-item')).toHaveLength(0);
  });

  it('does not call onSelect on click — only on mouseDown (prevents textarea blur)', () => {
    const onSelect = vi.fn();
    render(
      <SlashDropdown commands={commands} visible={true} selectedIndex={0} onSelect={onSelect} />
    );
    fireEvent.click(screen.getByText('/save').closest('.slash-item')!);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
