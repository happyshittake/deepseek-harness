/** @vitest-environment jsdom */
import { expect, it } from 'vitest'
import { clearAmbientProxyEnv } from './test-proxy-environment.ts'

it('loads proxy setup in the DOM test environment', () => {
  expect(document.createElement('div').tagName).toBe('DIV')
  const env: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://proxy.example:8080', PATH: '/bin' }
  expect(clearAmbientProxyEnv(env)).toEqual(['HTTPS_PROXY'])
  expect(env).toEqual({ PATH: '/bin' })
})
