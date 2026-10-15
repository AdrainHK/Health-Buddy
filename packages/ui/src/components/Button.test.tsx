import { render, screen } from '@testing-library/react';
import { Button, IconButton } from './Button';

describe('Button', () => {
  it('defaults to type="button" so it never submits a form by accident', () => {
    render(<Button>保存</Button>);
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('type', 'button');
  });

  it('gives icon-only buttons an accessible name', () => {
    render(<IconButton label="收起侧栏" icon={<svg />} />);
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBeInTheDocument();
  });
});
