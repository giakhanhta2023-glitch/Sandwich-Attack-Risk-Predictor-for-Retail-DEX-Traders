import { useEffect, useState } from 'react'
import type { AnchorHTMLAttributes, MouseEvent } from 'react'

/**
 * Path routing without a router dependency.
 *
 * Four views do not justify a library. Paths are real URLs, so the live
 * dashboard and the legal pages can be linked to and bookmarked; Vercel
 * rewrites unknown paths to index.html so a direct visit lands here.
 */

const listeners = new Set<() => void>()

export function navigate(to: string) {
  const url = new URL(to, window.location.origin)
  const samePath = url.pathname === window.location.pathname
  window.history.pushState(null, '', url.pathname + url.search + url.hash)
  listeners.forEach((notify) => notify())

  if (url.hash) {
    // Wait two frames so the destination view has rendered before scrolling,
    // then announce the hash so anything keyed on it (the research panel) opens.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.getElementById(url.hash.slice(1))?.scrollIntoView({ behavior: samePath ? 'smooth' : 'auto' })
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      }),
    )
  } else {
    window.scrollTo({ top: 0 })
  }
}

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const sync = () => setPath(window.location.pathname)
    listeners.add(sync)
    window.addEventListener('popstate', sync)
    return () => {
      listeners.delete(sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  return path
}

/** An anchor that navigates in-app. Modified clicks still open a new tab. */
export function Link({
  to,
  onClick,
  ...props
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return <a href={to} onClick={handle} {...props} />
}
