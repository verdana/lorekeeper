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
          500: '#8A7A62'  // Secondary text (weak)
        },
        // Override built-in slate with warm-wood text tones (deep brown, not blue-grey)
        slate: {
          400: '#A89676',
          500: '#8A7A62',
          600: '#6B5B47', // Secondary text
          700: '#4E3E30', // Tertiary heading
          800: '#3B2F24', // Primary text
          900: '#2A2018'  // Deepest text / high contrast
        },
        star: {
          gold: '#B8642E',   // Primary accent (deep copper-orange)
          silver: '#A89676', // Secondary
          mercury: '#7A5C4E', // Info (warm brown-purple)
          copper: '#6B8E4E', // Success (olive green)
          iron: '#A64A3F',   // Error / danger (brick red)
          tin: '#4E7D8A',    // Info blue (teal, non-glaring)
          lead: '#A89676'    // Muted grey
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
