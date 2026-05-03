/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        ink: {
          50:  '#f7f7f8',
          100: '#eeeef1',
          200: '#d9d9df',
          300: '#b6b6c0',
          400: '#8a8a96',
          500: '#5c5c68',
          600: '#3d3d46',
          700: '#27272d',
          800: '#1a1a1f',
          900: '#101014',
        },
        accent: {
          DEFAULT: '#7c5cff',
          soft: '#a892ff',
        },
      },
    },
  },
  plugins: [],
}
