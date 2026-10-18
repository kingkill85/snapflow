import { defineConfig } from 'orval'

// Generates typed TanStack Query hooks from the backend's OpenAPI document.
// Run `make api` after changing the backend; never edit src/api/generated.
export default defineConfig({
  snapflow: {
    input: '../api/openapi.json',
    output: {
      target: 'src/api/generated/snapflow.ts',
      schemas: 'src/api/generated/model',
      mode: 'tags-split',
      client: 'react-query',
      httpClient: 'axios',
      clean: true,
      override: {
        mutator: { path: 'src/api/client.ts', name: 'apiClient' },
      },
    },
  },
})
