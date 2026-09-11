/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/app/**/*.{js,ts,jsx,tsx,mdx}', './src/components/**/*.{js,ts,jsx,tsx,mdx}'],
  blocklist: ['[-:\\s]'],
  theme: {
    extend: {
      colors: {
        bg0: 'var(--bg-0)',
        bg1: 'var(--bg-1)',
        ink0: 'var(--ink-0)',
        ink1: 'var(--ink-1)',
        ink2: 'var(--ink-2)',
        line0: 'var(--line-0)',
        line1: 'var(--line-1)',
        surface: 'var(--surface)',
        'surface-soft': 'var(--surface-soft)',
        accent: 'var(--accent)',
        'accent-strong': 'var(--accent-strong)',
        'accent-ghost': 'var(--accent-ghost)',
        // These three exist as CSS variables in globals.css but were never registered here, so
        // classes like `bg-accent-soft` compiled to nothing at all — no rule, no error. That is
        // why selected states (nav item, active tab, chosen card) showed a border and coloured
        // text but no fill. `accent-soft` alone was used in nine components.
        'accent-soft': 'var(--accent-soft)',
        'surface-strong': 'var(--surface-strong)',
        'surface-user': 'var(--surface-user)',
        danger: 'var(--danger)',
        ok: 'var(--ok)',
        warn: 'var(--warn)',
      },
      borderRadius: {
        xl: 'var(--radius-xl)',
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
      },
      boxShadow: {
        a: 'var(--shadow-a)',
        b: 'var(--shadow-b)',
      },
      fontFamily: {
        heading: ['var(--font-heading)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
