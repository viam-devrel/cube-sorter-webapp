    // vite.config.js
    import { defineConfig } from 'vite';

    export default defineConfig({
        base: "./",
      build: {
        rollupOptions: {
          output: {
            // Customize asset filenames and their location
            assetFileNames: '[name].[hash][extname]', // Example: assets/image.abc123.png
            // If you want assets directly in dist root:
            // assetFileNames: '[name].[hash][extname]', 
          },
        },
      },
    });