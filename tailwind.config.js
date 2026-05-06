/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'brand-dark': '#323232',
        'brand-plum': '#473742',
        'brand-plum-light': '#5e4a56',
        'brand-plum-lighter': '#f0eaed',
        'brand-plum-muted': '#8a7380',
        'eh-gold': '#e8b176',
        'eh-gold-bright': '#f0c089',
        'eh-orange': '#e8825f',
        'eh-cream': '#f5e9d3',
      },
      fontFamily: {
        eh: ['"Senmoly Caligan"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
