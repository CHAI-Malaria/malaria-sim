import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // For GitHub Pages: set base to your repo name
  // Change 'malaria-sim' if your repo has a different name
  base: '/malaria-sim/',
})
