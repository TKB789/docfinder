import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' makes the build work on GitHub Pages
// regardless of your repository name.
export default defineConfig({
  plugins: [react()],
  base: './',
})
