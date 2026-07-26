/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Lorekeeper theme: parchment wood — warm paper base, deep-brown text, copper accents
        // Ink scale: background/border/muted text. Higher = deeper (warm spectrum).
        ink: {
          950: '#F2EBDD', // Page base (parchment)
          900: '#EAE0CB', // Sidebar / card bg (slightly darker parchment)
          850: '#E4D6BD', // Light bg / pill bg
          800: '#D8CBB0', // Primary border
          700: '#C4B490', // Hover border / strong border
          600: '#A89676', // Muted icon
          500: '#8A7A62',  // Secondary text (weak)

          // Semantic text colors (matches the warm-wood tones that were in slate)
          deep: '#2A2018',   // Deepest / headings (was ink-deep)
          body: '#3B2F24',   // Primary body text (was ink-body)
          muted: '#4E3E30',  // Secondary/muted text (was ink-muted)
          faint: '#6B5B47',  // Tertiary / faint text (was ink-faint)
          subtle: '#8A7A62', // Subtle / disabled text (matches ink-500)
          dim: '#A89676'     // Dim / placeholder text (matches ink-600)
        },
        star: {
          accent: '#B8642E',   // Primary accent (deep copper-orange)
          neutral: '#A89676', // Neutral
          warm: '#7A5C4E',    // Warm accent (brown-purple)
          success: '#6B8E4E',   // Success (olive green)
          danger: '#A64A3F',    // Error / danger (brick red)
          info: '#4E7D8A',      // Info (teal)
        }
      },
      fontFamily: {
        serif: ['"Noto Serif SC"', 'Songti SC', 'SimSun', 'serif'],
        sans: ['"Space Grotesk"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
}
