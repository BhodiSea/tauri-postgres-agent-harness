import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { navigate, usePathname } from './router'

afterEach(() => {
  window.history.pushState(null, '', '/')
})

describe('router', () => {
  it('usePathname reflects navigate() and Back/Forward (popstate)', () => {
    const { result } = renderHook(() => usePathname())
    expect(result.current).toBe('/')

    act(() => {
      navigate('/matrix')
    })
    expect(result.current).toBe('/matrix')

    act(() => {
      window.history.pushState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(result.current).toBe('/')
  })
})
